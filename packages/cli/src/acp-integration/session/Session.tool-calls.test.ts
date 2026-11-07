/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOOP_DETECTED_TURN_ERROR_MESSAGE, Session } from './Session.js';
import { markApiHistoryPrompt } from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type { DaemonToolLoopState } from './Session.js';
import type { Content, FunctionCall, Part } from '@google/genai';
import type { ChatRecord, Config, LlmChat } from '@qwen-code/qwen-code-core';
import { ApprovalMode, AuthType } from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import { createAgentHostToolInvocationGuard } from '@qwen-code/qwen-code-core/agents/workspace-agents/capability.js';
import { SettingScope } from '../../config/settings.js';
import type {
  AgentSideConnection,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';
import {
  CHANNEL_OUTPUT_MODE_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_TASK_OUTPUT_META_KEY,
  CHANNEL_TASK_RESULT_META_KEY,
} from '@qwen-code/channel-base';
import { EventBus } from '@qwen-code/acp-bridge/eventBus';
import {
  BridgeClient,
  type BridgeClientSessionEntry,
} from '@qwen-code/acp-bridge/bridgeClient';
import { createRepeatedToolFailureGuardState } from './repeated-tool-failure-guard.js';
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

// Helper to create empty async generator (avoids memory leak from inline generators)
function createEmptyStream() {
  return (async function* () {})();
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

function createFailingStream(message: string, beforeThrow?: () => void) {
  return (async function* () {
    beforeThrow?.();
    yield* [];
    throw new Error(message);
  })();
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

  describe('runToolCalls', () => {
    it.each([false, true])(
      'keeps code mode cancellation lifecycle open until execute settles (disposed=%s)',
      async (disposeBeforeSettle) => {
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
        const controller = new AbortController();
        let resolveExecution!: (result: {
          llmContent: string;
          returnDisplay: string;
        }) => void;
        const execute = vi.fn(
          () =>
            new Promise<{ llmContent: string; returnDisplay: string }>(
              (resolve) => {
                resolveExecution = resolve;
              },
            ),
        );
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool('read_file', execute),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        });
        const updates = vi.spyOn(session, 'sendUpdate');
        const internals = session as unknown as {
          runTool: (
            signal: AbortSignal,
            promptId: string,
            call: { id: string; name: string; args: Record<string, unknown> },
            a?: undefined,
            b?: undefined,
            c?: undefined,
            d?: undefined,
            e?: undefined,
            f?: undefined,
            context?: { parentCallId: string; source: 'code_mode' },
          ) => Promise<unknown>;
          disposed: boolean;
        };
        const running = internals.runTool(
          controller.signal,
          'nested-race',
          { id: 'nested-race-call', name: 'read_file', args: {} },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { parentCallId: 'parent', source: 'code_mode' },
        );
        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        controller.abort();
        await running;
        const events = () =>
          updates.mock.calls
            .map(([update]) => update._meta?.['toolLifecycle'])
            .filter(Boolean);
        expect(events()).toEqual([
          expect.objectContaining({ phase: 'started' }),
        ]);
        if (disposeBeforeSettle) internals.disposed = true;
        resolveExecution({
          llmContent: 'late completion',
          returnDisplay: 'late completion',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(events()).toHaveLength(disposeBeforeSettle ? 1 : 2);
        if (!disposeBeforeSettle)
          expect(events()[1]).toMatchObject({
            phase: 'ended',
            executionStatus: 'cancelled',
            outcome: 'cancelled',
          });
      },
    );

    it('separates approval time from actual execution lifecycle timing', async () => {
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      let elapsed = 0;
      const wall = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => 1000 + elapsed);
      const monotonic = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => elapsed);
      const updates = vi.spyOn(session, 'sendUpdate');
      const execute = vi.fn().mockImplementation(async () => {
        elapsed += 20;
        return { llmContent: 'executed', returnDisplay: 'executed' };
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('mcp__inventory__lookup', execute),
      );
      vi.mocked(mockClient.requestPermission).mockImplementation(async () => {
        expect(
          updates.mock.calls.some(
            ([update]) => update._meta?.['toolLifecycle'],
          ),
        ).toBe(false);
        elapsed += 30_000;
        return { outcome: { outcome: 'selected', optionId: 'proceed_once' } };
      });
      try {
        await (session as unknown as ToolCallInternals).runToolCalls(
          new AbortController().signal,
          'tool-timing',
          [{ id: 'approval-timing', name: 'mcp__inventory__lookup', args: {} }],
        );
        const lifecycle = updates.mock.calls
          .map(([update]) => update._meta?.['toolLifecycle'])
          .filter(Boolean);
        expect(lifecycle).toEqual([
          expect.objectContaining({
            phase: 'started',
            startedAt: 31_000,
            executionStatus: 'running',
          }),
          expect.objectContaining({
            phase: 'ended',
            startedAt: 31_000,
            endedAt: 31_020,
            executionDurationMs: 20,
            executionStatus: 'success',
            outcome: 'success',
          }),
        ]);
        expect(execute).toHaveBeenCalledOnce();
        expect(updates.mock.calls.map(([update]) => update)).toContainEqual(
          expect.objectContaining({
            _meta: expect.objectContaining({
              startedAt: 1000,
              durationMs: 30_020,
            }),
          }),
        );
      } finally {
        wall.mockRestore();
        monotonic.mockRestore();
      }
    });

    it.each([false, true])(
      'emits approved tool metadata before execution with preparation=%s',
      async (prepared) => {
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
        const toolName = 'mcp__inventory__lookup';
        const args = {
          query: 'approved item',
          description: 'Lookup approved data',
        };
        const updates = vi.spyOn(session, 'sendUpdate');
        let beforeExecution: Array<Parameters<Session['sendUpdate']>[0]> = [];
        const execute = vi.fn().mockImplementation(async () => {
          beforeExecution = updates.mock.calls.map(([update]) => update);
          return { llmContent: 'executed', returnDisplay: 'executed' };
        });
        const tool = mockConfirmingTool(toolName, execute);
        tool.displayName = 'Inventory lookup';
        tool.kind = core.Kind.Read;
        const invocation = tool.build();
        invocation.getDescription.mockReturnValue('Lookup approved data');
        invocation.toolLocations.mockReturnValue([
          { path: '/tmp/approved-item', line: 7 },
        ]);
        mockToolRegistry.getTool.mockReturnValue(tool);
        vi.mocked(mockClient.requestPermission).mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        });
        vi.spyOn(core, 'logToolCall').mockImplementation(() => {});
        if (prepared) {
          await (
            session as unknown as {
              toolCallEmitter: import('./emitters/tool-call-emitter.js').ToolCallEmitter;
            }
          ).toolCallEmitter.emitStart({
            callId: 'approved-metadata',
            toolName,
            args: {},
            phase: 'preparing',
          });
        }
        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(new AbortController().signal, 'approved-prompt', [
          { id: 'approved-metadata', name: toolName, args },
        ]);
        expect(execute).toHaveBeenCalledOnce();
        expect(result.parts[0]?.functionResponse?.response).toEqual({
          output: 'executed',
        });
        expect(
          beforeExecution.filter(
            (update) =>
              'toolCallId' in update &&
              update.toolCallId === 'approved-metadata' &&
              update.status === 'in_progress',
          ),
        ).toEqual([
          expect.objectContaining({
            sessionUpdate: prepared ? 'tool_call_update' : 'tool_call',
            toolCallId: 'approved-metadata',
            status: 'in_progress',
            rawInput: args,
            title: 'Inventory lookup: Lookup approved data',
            kind: 'read',
            locations: [{ path: '/tmp/approved-item', line: 7 }],
            _meta: expect.objectContaining({
              toolName,
              startedAt: expect.any(Number),
              provenance: 'mcp',
              serverId: 'inventory',
            }),
          }),
        ]);
      },
    );

    it('sends approved arguments before execution starts', async () => {
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      const args = {
        command: 'printf approved',
        description: 'Inspect approved command',
      };
      const updates = vi.spyOn(session, 'sendUpdate');
      const execute = vi.fn().mockImplementation(async () => {
        expect(updates.mock.calls.map(([update]) => update)).toContainEqual(
          expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'approved-call',
            status: 'in_progress',
            rawInput: args,
            _meta: expect.objectContaining({
              toolName: 'approved_tool',
              startedAt: expect.any(Number),
            }),
          }),
        );
        return { llmContent: 'executed', returnDisplay: 'executed' };
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('approved_tool', execute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });
      vi.spyOn(core, 'logToolCall').mockImplementation(() => {});
      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'approved-prompt', [
        { id: 'approved-call', name: 'approved_tool', args },
      ]);
      expect(execute).toHaveBeenCalledOnce();
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(result.parts[0]?.functionResponse?.response).toEqual({
        output: 'executed',
      });
    });

    it('executes an approved tool even if timing notification fails', async () => {
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'executed',
        returnDisplay: 'executed',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('timing_tool', execute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      });
      const original = session.sendUpdate.bind(session);
      let rejectedTiming = 0;
      vi.spyOn(session, 'sendUpdate').mockImplementation(async (update) => {
        if (
          update.sessionUpdate === 'tool_call' &&
          update.status === 'in_progress' &&
          update._meta?.['startedAt']
        ) {
          rejectedTiming++;
          throw new Error('timing transport failure');
        }
        return original(update);
      });
      vi.spyOn(core, 'logToolCall').mockImplementation(() => {});
      const result = await (
        session as unknown as {
          runToolCalls: (
            signal: AbortSignal,
            promptId: string,
            calls: FunctionCall[],
          ) => Promise<{ parts: Part[] }>;
        }
      ).runToolCalls(new AbortController().signal, 'timing-prompt', [
        { id: 'timing-call', name: 'timing_tool', args: {} },
      ]);
      expect(rejectedTiming).toBe(1);
      expect(execute).toHaveBeenCalledOnce();
      expect(result.parts[0]?.functionResponse?.response).toEqual({
        output: 'executed',
      });
    });

    type ToolCallInternals = {
      runToolCalls: (
        abortSignal: AbortSignal,
        promptId: string,
        functionCalls: FunctionCall[],
        toolLoopState?: DaemonToolLoopState,
        onFullTurnModel?: (model: string) => boolean,
      ) => Promise<{
        parts: Part[];
        stopAfterPermissionCancel: boolean;
        loopDetected?: boolean;
        repeatedToolFailureBatch?: {
          complete: boolean;
          observations: Array<{
            callId: string;
            policyToolName?: string;
            terminalStatus: 'success' | 'error' | 'cancelled';
            executionStatus?: core.ToolExecutionStatus | 'unknown';
            executionErrorType?: core.ToolErrorType;
            providerDuplicate?: boolean;
          }>;
        };
      }>;
    };

    it('delivers nested PreToolUse context with the exec result, not the script value', async () => {
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({
        request: vi
          .fn()
          .mockImplementation(
            async (request: {
              eventName: string;
              input?: { tool_name?: string; tool_call_id?: string };
            }) => ({
              success: true,
              output:
                request.eventName === 'PreToolUse' &&
                request.input?.tool_name === 'read_file'
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        additionalContext: `NESTED_CTX_${request.input.tool_call_id}`,
                      },
                    }
                  : {},
            }),
          ),
      });
      mockConfig.getTruncateToolOutputThreshold = vi
        .fn()
        .mockReturnValue(25_000);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockConfig.getToolMode = vi
        .fn()
        .mockReturnValue(core.ToolMode.CodeModeOnly);
      const nestedTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read file',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/example.txt' },
          execute: vi.fn().mockResolvedValue({
            llmContent: 'NESTED_RAW',
            returnDisplay: 'NESTED_RAW',
          }),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      let scriptValue: string | undefined;
      const outerTool = {
        name: core.ToolNames.EXEC,
        kind: core.Kind.Other,
        displayName: 'Exec',
        description: 'Exec',
        build: vi.fn().mockReturnValue({
          params: { source: 'probe' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Exec'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockImplementation(async (signal: AbortSignal) => {
            const nested = await core
              .getToolCallRuntime()!
              .dispatch('read_file', { path: '/tmp/example.txt' }, signal);
            // The script consumes the value without printing it.
            scriptValue = nested.output;
            return { llmContent: 'done', returnDisplay: 'done' };
          }),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.EXEC ? outerTool : nestedTool,
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-nested-ctx', [
        {
          id: 'exec-ctx',
          name: core.ToolNames.EXEC,
          args: { source: 'probe' },
        },
      ]);

      expect(scriptValue).toBe('NESTED_RAW');
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'done\n\nNESTED_CTX_exec-ctx:code:1',
      });
    });

    it('delivers nested PostToolUseFailure context with the exec result, not the script error', async () => {
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({
        request: vi
          .fn()
          .mockImplementation(
            async (request: {
              eventName: string;
              input?: { tool_name?: string; tool_call_id?: string };
            }) => ({
              success: true,
              output:
                request.eventName === 'PostToolUseFailure' &&
                request.input?.tool_name === 'read_file'
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PostToolUseFailure',
                        additionalContext: `NESTED_FAIL_${request.input.tool_call_id}`,
                      },
                    }
                  : {},
            }),
          ),
      });
      mockConfig.getTruncateToolOutputThreshold = vi
        .fn()
        .mockReturnValue(25_000);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockConfig.getToolMode = vi
        .fn()
        .mockReturnValue(core.ToolMode.CodeModeOnly);
      const nestedTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read file',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/missing.txt' },
          execute: vi.fn().mockResolvedValue({
            llmContent: 'missing',
            returnDisplay: 'missing',
            error: {
              message: 'missing',
              type: core.ToolErrorType.EXECUTION_FAILED,
            },
          }),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      let scriptError: string | undefined;
      const outerTool = {
        name: core.ToolNames.EXEC,
        kind: core.Kind.Other,
        displayName: 'Exec',
        description: 'Exec',
        build: vi.fn().mockReturnValue({
          params: { source: 'probe' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Exec'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockImplementation(async (signal: AbortSignal) => {
            try {
              await core
                .getToolCallRuntime()!
                .dispatch('read_file', { path: '/tmp/missing.txt' }, signal);
            } catch (error) {
              // The script swallows the error without printing it.
              scriptError = (error as Error).message;
            }
            return { llmContent: 'done', returnDisplay: 'done' };
          }),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.EXEC ? outerTool : nestedTool,
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-nested-fail', [
        {
          id: 'exec-fail',
          name: core.ToolNames.EXEC,
          args: { source: 'probe' },
        },
      ]);

      expect(scriptError).toBe('missing');
      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'done\n\nNESTED_FAIL_exec-fail:code:1',
      });
    });

    it('allows top-level discovery then re-enters the ACP tool chain with native result metadata', async () => {
      const onResult = vi.fn();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockConfig.getToolMode = vi
        .fn()
        .mockReturnValue(core.ToolMode.CodeModeOnly);
      const nestedExecute = vi.fn().mockImplementation(async () => {
        expect(core.getToolCallRuntime()).toBeUndefined();
        return {
          llmContent: [
            { text: 'nested ACP output' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'QUJD',
              },
            },
          ],
          returnDisplay: 'nested ACP output',
          modelOverride: undefined,
          terminateTurn: true,
        };
      });
      const nestedTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read file',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/example.txt' },
          execute: nestedExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      const outerTool = {
        name: core.ToolNames.EXEC,
        kind: core.Kind.Other,
        displayName: 'Exec',
        description: 'Exec',
        build: vi.fn().mockReturnValue({
          params: { source: 'probe' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Exec'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockImplementation(async (signal: AbortSignal) => {
            const runtime = core.getToolCallRuntime();
            if (!runtime) throw new Error('missing runtime');
            const nested = await runtime.dispatch(
              'read_file',
              { path: '/tmp/example.txt' },
              signal,
              onResult,
            );
            expect(nested.content).toEqual([
              { type: 'image', mimeType: 'image/png', data: 'QUJD' },
            ]);
            return {
              llmContent: nested.output,
              returnDisplay: nested.output,
            };
          }),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      const searchExecute = vi.fn().mockResolvedValue({
        llmContent: 'tools.read_file(args: { file_path: string })',
        returnDisplay: 'Reviewed read_file',
      });
      const searchTool = {
        ...outerTool,
        name: core.ToolNames.TOOL_SEARCH,
        build: vi.fn().mockReturnValue({
          params: { query: 'select:read_file' },
          execute: searchExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Search'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.EXEC
          ? outerTool
          : name === core.ToolNames.TOOL_SEARCH
            ? searchTool
            : nestedTool,
      );
      const search = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-code-mode-search', [
        {
          id: 'search-acp',
          name: core.ToolNames.TOOL_SEARCH,
          args: { query: 'select:read_file' },
        },
      ]);
      expect(searchExecute).toHaveBeenCalledOnce();
      expect(search.parts[0].functionResponse?.response?.['output']).toContain(
        'tools.read_file',
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-code-mode-acp', [
        {
          id: 'exec-acp-parent',
          name: core.ToolNames.EXEC,
          args: { source: 'probe' },
        },
      ]);

      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({
          modelOverride: undefined,
          terminateTurn: true,
          responseParts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                parts: [
                  { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
                ],
              }),
            }),
          ],
        }),
      );
      expect(Object.hasOwn(onResult.mock.calls[0][0], 'modelOverride')).toBe(
        true,
      );
      expect(nestedExecute).toHaveBeenCalledOnce();
      expect(mockToolRegistry.getTool).toHaveBeenCalledWith('read_file');
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].functionResponse?.name).toBe(core.ToolNames.EXEC);
      expect(result.parts[0].functionResponse?.response?.['output']).toBe(
        'nested ACP output',
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({ name: 'read_file' }),
          }),
        ]),
        expect.anything(),
        // Nested Code Mode originals are recorded with the branch's new
        // options argument marking them 'code_mode_tool_result'.
        expect.objectContaining({ subtype: 'code_mode_tool_result' }),
      );

      const direct = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-code-mode-direct', [
        {
          id: 'read-acp-direct',
          name: 'read_file',
          args: { path: '/tmp/example.txt' },
        },
      ]);
      expect(nestedExecute).toHaveBeenCalledOnce();
      expect(direct.parts[0].functionResponse?.response?.['error']).toContain(
        'unavailable on this CodeModeOnly call surface',
      );
    });

    describe('Code Mode nested concurrency', () => {
      type Runtime = NonNullable<ReturnType<typeof core.getToolCallRuntime>>;
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      const output = (value: string): core.ToolResult => ({
        llmContent: value,
        returnDisplay: value,
      });
      const nestedTool = (
        name: string,
        kind: core.Kind | undefined,
        execute: (
          signal: AbortSignal,
          args: Record<string, unknown>,
          updateOutput?: (chunk: core.ToolResultDisplay) => void,
        ) => Promise<core.ToolResult>,
        permission: 'allow' | 'ask' | 'deny' = 'allow',
      ) => ({
        name,
        kind,
        build: (args: Record<string, unknown>) => {
          const invocation = {
            params: args,
            getDefaultPermission: async () => permission,
            getDescription: () => name,
            toolLocations: () => [],
            getConfirmationDetails: async () => ({
              type: 'info' as const,
              title: name,
              prompt: 'Allow?',
              onConfirm: vi.fn(),
            }),
            execute: (
              signal: AbortSignal,
              updateOutput?: (chunk: core.ToolResultDisplay) => void,
            ) => execute(signal, invocation.params, updateOutput),
          };
          return invocation;
        },
      });
      const runCode = (
        tools: Array<ReturnType<typeof nestedTool>>,
        program: (runtime: Runtime, signal: AbortSignal) => Promise<unknown>,
        signal = new AbortController().signal,
      ) => {
        const exec = nestedTool(
          core.ToolNames.EXEC,
          core.Kind.Other,
          async (signal) => {
            const runtime = core.getToolCallRuntime();
            if (!runtime) throw new Error('missing Code Mode runtime');
            return output(JSON.stringify(await program(runtime, signal)));
          },
        );
        mockToolRegistry.getTool.mockImplementation((name: string) =>
          [exec, ...tools].find((tool) => tool.name === name),
        );
        return (session as unknown as ToolCallInternals).runToolCalls(
          signal,
          'code-concurrency',
          [{ id: 'exec-parent', name: core.ToolNames.EXEC, args: {} }],
        );
      };
      beforeEach(() => {
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
        mockConfig.getToolMode = vi
          .fn()
          .mockReturnValue(core.ToolMode.CodeModeOnly);
      });

      it('overlaps safe calls and keeps reversed results and persistence with their call IDs', async () => {
        const started = [deferred(), deferred()];
        const release = [deferred(), deferred()];
        const onResult = vi.fn();
        const tools = ['read_a', 'read_b'].map((name, index) =>
          nestedTool(name, core.Kind.Read, async () => {
            expect(core.getToolCallRuntime()).toBeUndefined();
            started[index].resolve();
            await release[index].promise;
            return output(name);
          }),
        );
        const running = runCode(tools, (runtime, signal) =>
          Promise.allSettled(
            tools.map((tool) =>
              runtime.dispatch(tool.name, {}, signal, onResult),
            ),
          ),
        );
        await Promise.all(started.map(({ promise }) => promise));
        release[1].resolve();
        release[0].resolve();
        const result = await running;
        expect(
          JSON.parse(
            String(result.parts[0].functionResponse?.response?.['output']),
          ),
        ).toEqual([
          {
            status: 'fulfilled',
            value: expect.objectContaining({
              callId: 'exec-parent:code:1',
              output: 'read_a',
            }),
          },
          {
            status: 'fulfilled',
            value: expect.objectContaining({
              callId: 'exec-parent:code:2',
              output: 'read_b',
            }),
          },
        ]);
        const recorded = mockChatRecordingService.recordToolResult.mock.calls;
        expect(recorded).toHaveLength(3);
        expect(recorded.map(([, metadata]) => metadata.callId)).toEqual([
          'exec-parent:code:2',
          'exec-parent:code:1',
          'exec-parent',
        ]);
        expect(recorded.map(([, , options]) => options)).toEqual([
          { subtype: 'code_mode_tool_result' },
          { subtype: 'code_mode_tool_result' },
          undefined,
        ]);
        for (const [parts, metadata] of recorded) {
          expect(parts).toHaveLength(1);
          expect(parts[0].functionResponse?.id).toBe(metadata.callId);
        }
        expect(
          onResult.mock.calls.map(
            ([value]) =>
              value.responseParts[0].functionResponse.response.output,
          ),
        ).toEqual(['read_b', 'read_a']);
      });

      it('keeps the Goal turn stamp on nested Code Mode originals', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-code-mode',
          revision: 1,
          turnId: 'turn-code-mode',
        };
        const nested = nestedTool('read_nested', core.Kind.Read, async () =>
          output('nested fact'),
        );
        const onResult = vi.fn();
        await core.goalTurnContext.run(permit, () =>
          runCode([nested], (runtime, signal) =>
            runtime.dispatch(nested.name, {}, signal, onResult),
          ),
        );
        const recorded = mockChatRecordingService.recordToolResult.mock.calls;
        expect(recorded.map(([, metadata]) => metadata.callId)).toEqual([
          'exec-parent:code:1',
          'exec-parent',
        ]);
        expect(recorded.map(([, , options]) => options)).toEqual([
          { goalContext: permit, subtype: 'code_mode_tool_result' },
          { goalContext: permit, provenance: 'execution_output' },
        ]);
      });

      it('overlaps independent Bash calls with commands that are not read-only', async () => {
        const started: string[] = [];
        const release = deferred();
        const commands = ['npm test --workspace=a', 'npm test --workspace=b'];
        const shell = nestedTool(
          core.ToolNames.SHELL,
          core.Kind.Execute,
          async (_signal, args) => {
            const command = String(args['command']);
            started.push(command);
            await release.promise;
            return output(command);
          },
        );
        const running = runCode([shell], (runtime, signal) =>
          Promise.allSettled(
            commands.map((command) =>
              runtime.dispatch(shell.name, { command }, signal),
            ),
          ),
        );
        try {
          await vi.waitFor(() => expect(started).toEqual(commands));
        } finally {
          release.resolve();
          await running;
        }
        const result = await running;
        expect(
          JSON.parse(
            String(result.parts[0].functionResponse?.response?.['output']),
          ),
        ).toEqual(
          commands.map((command) => ({
            status: 'fulfilled',
            value: expect.objectContaining({ output: command }),
          })),
        );
      });

      it.each([true, false])(
        'preserves concurrent AUTO denial state when the later result blocks=%s',
        async (laterBlocks) => {
          let denialState: core.AutoModeDenialState = {
            consecutiveBlock: 0,
            consecutiveUnavailable: 0,
            totalBlock: 0,
            totalUnavailable: 0,
          };
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.AUTO);
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
          const release = [deferred(), deferred()];
          const classify = vi.spyOn(core, 'evaluateAutoMode');
          for (const [index, gate] of release.entries()) {
            classify.mockImplementationOnce(async () => {
              await gate.promise;
              return {
                via: 'classifier',
                shouldBlock: index === 0 || laterBlocks,
                reason: 'test decision',
                unavailable: false,
                stage: 'fast',
                durationMs: 0,
              };
            });
          }
          const commands = ['npm test --workspace=a', 'npm test --workspace=b'];
          const execute = vi.fn(async () => output('ok'));
          const shell = nestedTool(
            core.ToolNames.SHELL,
            core.Kind.Execute,
            execute,
            'ask',
          );
          const running = runCode([shell], (runtime, signal) =>
            Promise.allSettled(
              commands.map((command) =>
                runtime.dispatch(shell.name, { command }, signal),
              ),
            ),
          );
          try {
            await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));
            release[0].resolve();
            await vi.waitFor(() => expect(denialState.totalBlock).toBe(1));
          } finally {
            release.forEach((gate) => gate.resolve());
            await running;
          }
          expect(denialState).toEqual({
            consecutiveBlock: laterBlocks ? 2 : 0,
            consecutiveUnavailable: 0,
            totalBlock: laterBlocks ? 2 : 1,
            totalUnavailable: 0,
            pendingManualRetryFingerprint: core.getAutoModeActionFingerprint(
              shell.name,
              { command: commands[laterBlocks ? 1 : 0] },
              mockConfig.getCwd(),
            ),
          });
          expect(execute).toHaveBeenCalledTimes(laterBlocks ? 0 : 1);
          expect(mockClient.requestPermission).not.toHaveBeenCalled();
        },
      );

      it('caps active calls and starts the next queued read when a slot becomes free', async () => {
        vi.stubEnv('QWEN_CODE_MAX_TOOL_CONCURRENCY', '2');
        const started: number[] = [];
        const release = [deferred(), deferred(), deferred()];
        const tools = release.map((gate, index) =>
          nestedTool(`read_${index}`, core.Kind.Read, async () => {
            started.push(index);
            await gate.promise;
            return output(String(index));
          }),
        );
        const running = runCode(tools, (runtime, signal) =>
          Promise.allSettled(
            tools.map((tool) => runtime.dispatch(tool.name, {}, signal)),
          ),
        );
        await vi.waitFor(() => expect(started).toEqual([0, 1]));
        release[1].resolve();
        await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
        release[0].resolve();
        release[2].resolve();
        await running;
      });

      it.each([core.Kind.Edit, undefined])(
        'keeps %s calls as ordered barriers between safe reads',
        async (kind) => {
          const events: string[] = [];
          const release = [deferred(), deferred()];
          const tools = [
            nestedTool('read_before', core.Kind.Read, async () => {
              events.push('read_before');
              await release[0].promise;
              return output('before');
            }),
            nestedTool('barrier', kind, async () => {
              events.push('barrier');
              await release[1].promise;
              return output('barrier');
            }),
            nestedTool('read_after', core.Kind.Read, async () => {
              events.push('read_after');
              return output('after');
            }),
          ];
          const running = runCode(tools, (runtime, signal) =>
            Promise.allSettled(
              tools.map((tool) => runtime.dispatch(tool.name, {}, signal)),
            ),
          );
          await vi.waitFor(() => expect(events).toEqual(['read_before']));
          release[0].resolve();
          await vi.waitFor(() =>
            expect(events).toEqual(['read_before', 'barrier']),
          );
          release[1].resolve();
          await running;
          expect(events).toEqual(['read_before', 'barrier', 'read_after']);
        },
      );

      it('preserves explicit sequential awaits', async () => {
        const release = deferred();
        const events: string[] = [];
        const tool = nestedTool(
          'read_file',
          core.Kind.Read,
          async (_signal, args) => {
            events.push(String(args['id']));
            if (args['id'] === 1) await release.promise;
            return output(String(args['id']));
          },
        );
        const running = runCode([tool], async (runtime, signal) => {
          await runtime.dispatch(tool.name, { id: 1 }, signal);
          return runtime.dispatch(tool.name, { id: 2 }, signal);
        });
        await vi.waitFor(() => expect(events).toEqual(['1']));
        release.resolve();
        await running;
        expect(events).toEqual(['1', '2']);
      });

      it.each(['execution error', 'permission denial'])(
        'retains independent output after an ordinary %s',
        async (failure) => {
          const failed = nestedTool(
            'read_fail',
            core.Kind.Read,
            async () => {
              throw new Error('read failed');
            },
            failure === 'permission denial' ? 'deny' : 'allow',
          );
          const succeed = nestedTool(
            'read_ok',
            core.Kind.Read,
            async (signal) => {
              expect(signal.aborted).toBe(false);
              return output('kept');
            },
          );
          const result = await runCode(
            [failed, succeed],
            async (runtime, signal) => {
              const settled = await Promise.allSettled([
                runtime.dispatch(failed.name, {}, signal),
                runtime.dispatch(succeed.name, {}, signal),
              ]);
              return settled.map((result) =>
                result.status === 'rejected'
                  ? { status: result.status, reason: String(result.reason) }
                  : result,
              );
            },
          );
          expect(result.stopAfterPermissionCancel).toBe(false);
          expect(
            JSON.parse(
              String(result.parts[0].functionResponse?.response?.['output']),
            ),
          ).toEqual([
            {
              status: 'rejected',
              reason: expect.stringContaining(
                failure === 'permission denial' ? 'denied' : 'read failed',
              ),
            },
            {
              status: 'fulfilled',
              value: expect.objectContaining({ output: 'kept' }),
            },
          ]);
        },
      );

      it('propagates nested permission cancellation through allSettled and cancels active and queued work', async () => {
        vi.stubEnv('QWEN_CODE_MAX_TOOL_CONCURRENCY', '2');
        const started = deferred();
        const aborted = vi.fn();
        const queued = vi.fn().mockResolvedValue(output('should not run'));
        const active = nestedTool(
          'read_active',
          core.Kind.Read,
          async (signal) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted();
                  resolve();
                },
                { once: true },
              ),
            );
            return output('aborted');
          },
        );
        const confirming = nestedTool(
          'read_confirm',
          core.Kind.Read,
          vi.fn(),
          'ask',
        );
        vi.mocked(mockClient.requestPermission).mockImplementation(async () => {
          await started.promise;
          return { outcome: { outcome: 'cancelled' } };
        });
        const tools = [
          active,
          confirming,
          nestedTool('read_queued', core.Kind.Read, queued),
        ];
        const result = await runCode(tools, (runtime, signal) =>
          Promise.allSettled(
            tools.map((tool) => runtime.dispatch(tool.name, {}, signal)),
          ),
        );
        expect(result.stopAfterPermissionCancel).toBe(true);
        expect(aborted).toHaveBeenCalledOnce();
        expect(queued).not.toHaveBeenCalled();
        const recorded = mockChatRecordingService.recordToolResult.mock.calls;
        expect(recorded).toHaveLength(4);
        expect(
          recorded.slice(0, 3).every(([, meta]) => meta.status === 'cancelled'),
        ).toBe(true);
      });

      it.each(['parent', 'host'])(
        'cancels active and queued work on %s abort and drains records before returning',
        async (source) => {
          vi.stubEnv('QWEN_CODE_MAX_TOOL_CONCURRENCY', '2');
          const controller = new AbortController();
          const started = [deferred(), deferred()];
          const aborted = vi.fn();
          const queued = vi.fn().mockResolvedValue(output('should not run'));
          const tools = started.map((gate, index) =>
            nestedTool(`read_${index}`, core.Kind.Read, async (signal) => {
              gate.resolve();
              await new Promise<void>((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted();
                    resolve();
                  },
                  { once: true },
                ),
              );
              return output('cancelled');
            }),
          );
          tools.push(nestedTool('read_queued', core.Kind.Read, queued));
          const running = runCode(
            tools,
            (runtime, signal) =>
              Promise.allSettled(
                tools.map((tool) =>
                  runtime.dispatch(
                    tool.name,
                    {},
                    source === 'host' ? controller.signal : signal,
                  ),
                ),
              ),
            source === 'parent' ? controller.signal : undefined,
          );
          await Promise.all(started.map(({ promise }) => promise));
          controller.abort();
          const result = await running;
          expect(result.stopAfterPermissionCancel).toBe(false);
          expect(aborted).toHaveBeenCalledTimes(2);
          expect(queued).not.toHaveBeenCalled();
          const records = mockChatRecordingService.recordToolResult.mock.calls;
          expect(records).toHaveLength(4);
          expect(records.at(-1)?.[1].callId).toBe('exec-parent');
        },
      );

      it('cancels and drains unawaited dispatches before completing exec', async () => {
        vi.stubEnv('QWEN_CODE_MAX_TOOL_CONCURRENCY', '1');
        const started = deferred();
        const queued = vi.fn().mockResolvedValue(output('should not run'));
        const active = nestedTool(
          'read_active',
          core.Kind.Read,
          async (signal) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            return output('cancelled');
          },
        );
        let unawaited: Promise<unknown>;
        await runCode(
          [active, nestedTool('read_queued', core.Kind.Read, queued)],
          async (runtime, signal) => {
            unawaited = Promise.allSettled([
              runtime.dispatch('read_active', {}, signal),
              runtime.dispatch('read_queued', {}, signal),
            ]);
            await started.promise;
            return 'finished without awaiting tools';
          },
        );
        await unawaited!;
        expect(queued).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordToolResult.mock.calls.map(
            ([, meta]) => meta.callId,
          ),
        ).toEqual(['exec-parent:code:1', 'exec-parent:code:2', 'exec-parent']);
      });

      it.each([
        ['parent', 'success'],
        ['parent', 'error'],
        ['host', 'success'],
        ['host', 'error'],
        ['unawaited', 'success'],
        ['unawaited', 'error'],
      ] as const)(
        'settles unresponsive nested execution on %s cancellation and discards late %s',
        async (source, outcome) => {
          const controller = new AbortController();
          const started = deferred();
          const release = deferred();
          let executionFinished = false;
          const queued = vi.fn().mockResolvedValue(output('should not run'));
          const onResult = vi.fn();
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({});
          vi.spyOn(core, 'firePreToolUseHook').mockResolvedValue({
            shouldProceed: true,
          });
          const postHook = vi
            .spyOn(core, 'firePostToolUseHook')
            .mockResolvedValue({ shouldStop: false });
          const failureHook = vi
            .spyOn(core, 'firePostToolUseFailureHook')
            .mockResolvedValue({});
          const active = nestedTool(
            'read_unresponsive',
            core.Kind.Read,
            async (_signal, _args, updateOutput) => {
              started.resolve();
              try {
                await release.promise;
                updateOutput?.({ type: 'shell_progress', elapsedMs: 1000 });
                if (outcome === 'error') throw new Error('late failure');
                return output('late success');
              } finally {
                executionFinished = true;
              }
            },
          );
          let dispatched: Promise<unknown> | undefined;
          let finished = false;
          const running = runCode(
            [active, nestedTool('edit_queued', core.Kind.Edit, queued)],
            async (runtime, signal) => {
              const nestedSignal =
                source === 'host' ? controller.signal : signal;
              dispatched = Promise.allSettled([
                runtime.dispatch(active.name, {}, nestedSignal, onResult),
                runtime.dispatch('edit_queued', {}, nestedSignal),
              ]);
              await started.promise;
              if (source === 'unawaited') return 'finished';
              return dispatched;
            },
            source === 'parent' ? controller.signal : undefined,
          ).then((result) => {
            finished = true;
            return result;
          });
          try {
            await started.promise;
            if (source !== 'unawaited') controller.abort();
            await vi.waitFor(() => expect(finished).toBe(true));
            await running;
            await dispatched;
            expect(executionFinished).toBe(false);
            expect(queued).not.toHaveBeenCalled();
            expect(onResult).toHaveBeenCalledOnce();
            expect(onResult.mock.calls[0][0].error).toBeInstanceOf(Error);
            const records =
              mockChatRecordingService.recordToolResult.mock.calls;
            expect(records).toHaveLength(3);
            expect(records.at(-1)?.[1].callId).toBe('exec-parent');
            expect(records.slice(0, 2).map(([, meta]) => meta.status)).toEqual([
              'cancelled',
              'cancelled',
            ]);
            const updatesBeforeRelease = vi.mocked(mockClient.sessionUpdate)
              .mock.calls.length;
            const hooksBeforeRelease = failureHook.mock.calls.length;
            release.resolve();
            await vi.waitFor(() => expect(executionFinished).toBe(true));
            await new Promise<void>((resolve) => setImmediate(resolve));
            const lateUpdates = vi
              .mocked(mockClient.sessionUpdate)
              .mock.calls.slice(updatesBeforeRelease)
              .map(([params]) => params.update);
            expect(lateUpdates).toEqual([
              expect.objectContaining({
                sessionUpdate: 'tool_call_update',
                _meta: expect.objectContaining({
                  toolLifecycle: expect.objectContaining({
                    toolName: active.name,
                    phase: 'ended',
                    executionStatus: 'cancelled',
                    outcome: 'cancelled',
                  }),
                }),
              }),
            ]);
            expect(lateUpdates[0]).not.toHaveProperty('content');
            expect(lateUpdates[0]).not.toHaveProperty('status');
            expect(
              mockChatRecordingService.recordToolResult,
            ).toHaveBeenCalledTimes(3);
            expect(onResult).toHaveBeenCalledOnce();
            expect(failureHook).toHaveBeenCalledTimes(hooksBeforeRelease);
            expect(
              postHook.mock.calls.filter(([, name]) => name === active.name),
            ).toHaveLength(0);
          } finally {
            release.resolve();
            await running;
            await dispatched;
          }
        },
      );

      it('serializes nested shell calls once a skill registers a PreToolUse hook', async () => {
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.getMessageBus = vi.fn().mockReturnValue({});
        let registered = false;
        mockConfig.hasHooksForEvent = vi.fn(
          (event) => event === 'PreToolUse' && registered,
        );
        vi.spyOn(core, 'firePreToolUseHook').mockImplementation(async () =>
          registered
            ? {
                shouldProceed: true,
                updatedInput: { command: 'touch changed.txt' },
              }
            : { shouldProceed: true },
        );
        vi.spyOn(core, 'firePostToolUseHook').mockResolvedValue({
          shouldStop: false,
        });
        const skillRelease = deferred();
        const shellRelease = deferred();
        const events: string[] = [];
        const skill = nestedTool(
          core.ToolNames.SKILL,
          core.Kind.Read,
          async () => {
            events.push('skill');
            await skillRelease.promise;
            registered = true;
            return output('registered');
          },
        );
        const shell = nestedTool(
          core.ToolNames.SHELL,
          core.Kind.Execute,
          async (_signal, args) => {
            events.push(String(args['command']));
            if (events.length === 2) await shellRelease.promise;
            return output('done');
          },
        );
        const running = runCode([skill, shell], (runtime, signal) =>
          Promise.allSettled([
            runtime.dispatch(skill.name, {}, signal),
            runtime.dispatch(shell.name, { command: 'git status' }, signal),
            runtime.dispatch(shell.name, { command: 'git status' }, signal),
          ]),
        );
        await vi.waitFor(() => expect(events).toEqual(['skill']));
        skillRelease.resolve();
        await vi.waitFor(() =>
          expect(events).toEqual(['skill', 'touch changed.txt']),
        );
        // The second shell call waits for the first.
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        expect(events).toEqual(['skill', 'touch changed.txt']);
        shellRelease.resolve();
        await running;
        expect(events).toEqual([
          'skill',
          'touch changed.txt',
          'touch changed.txt',
        ]);
      });

      it('waits for skill hook registration before admitting shell calls whose hooks rewrite their arguments', async () => {
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.getMessageBus = vi.fn().mockReturnValue({});
        let registered = false;
        mockConfig.hasHooksForEvent = vi.fn(
          (event) => event === 'PermissionRequest' && registered,
        );
        const hook = vi
          .spyOn(core, 'firePermissionRequestHook')
          .mockResolvedValue({
            hasDecision: true,
            shouldAllow: true,
            updatedInput: { command: 'touch changed.txt' },
          });
        vi.spyOn(core, 'firePreToolUseHook').mockResolvedValue({
          shouldProceed: true,
        });
        vi.spyOn(core, 'firePostToolUseHook').mockResolvedValue({
          shouldStop: false,
        });
        const skillRelease = deferred();
        const shellRelease = deferred();
        const events: string[] = [];
        const skill = nestedTool(
          core.ToolNames.SKILL,
          core.Kind.Read,
          async () => {
            events.push('skill');
            await skillRelease.promise;
            registered = true;
            return output('registered');
          },
        );
        const shell = nestedTool(
          core.ToolNames.SHELL,
          core.Kind.Execute,
          async (_signal, args) => {
            events.push(String(args['command']));
            if (events.length === 2) await shellRelease.promise;
            return output('done');
          },
          'ask',
        );
        const running = runCode([skill, shell], (runtime, signal) =>
          Promise.allSettled([
            runtime.dispatch(skill.name, {}, signal),
            runtime.dispatch(shell.name, { command: 'git status' }, signal),
            runtime.dispatch(shell.name, { command: 'git status' }, signal),
          ]),
        );
        await vi.waitFor(() => expect(events).toEqual(['skill']));
        skillRelease.resolve();
        await vi.waitFor(() =>
          expect(events).toEqual(['skill', 'touch changed.txt']),
        );
        expect(hook).toHaveBeenCalledOnce();
        shellRelease.resolve();
        await running;
        expect(events).toEqual([
          'skill',
          'touch changed.txt',
          'touch changed.txt',
        ]);
        expect(hook).toHaveBeenCalledTimes(2);
        expect(mockClient.requestPermission).not.toHaveBeenCalled();
      });
    });

    function emitNestedAskUserQuestion(
      eventEmitter: EventEmitter,
      respond: ReturnType<typeof vi.fn>,
    ) {
      eventEmitter.emit(core.AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'subagent-1',
        round: 1,
        callId: 'nested_question',
        name: core.ToolNames.ASK_USER_QUESTION,
        description: 'Ask user',
        args: {},
        confirmationDetails: {
          type: 'ask_user_question',
          title: 'Question',
          questions: [{ header: 'Continue?', question: 'Continue?' }],
        },
        respond,
        timestamp: Date.now(),
      });
    }

    function emitNestedInfoPermission(
      eventEmitter: EventEmitter,
      respond: ReturnType<typeof vi.fn>,
    ) {
      eventEmitter.emit(core.AgentEventType.TOOL_WAITING_APPROVAL, {
        subagentId: 'subagent-1',
        round: 1,
        callId: 'nested_shell',
        name: core.ToolNames.SHELL,
        description: 'Shell permission',
        args: {},
        confirmationDetails: {
          type: 'info',
          title: 'Shell permission',
          prompt: 'Allow shell?',
        },
        respond,
        timestamp: Date.now(),
      });
    }

    function waitForAbortOrTick(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const timeout = setTimeout(resolve, 10);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
    }

    function mockAllowedTool(name: string, execute: ReturnType<typeof vi.fn>) {
      return {
        name,
        kind: core.Kind.Read,
        displayName: name,
        description: name,
        build: vi.fn().mockReturnValue({
          params: {},
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
    }

    function recreateStandaloneSession() {
      session.dispose();
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
      session = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
      );
    }

    const trustedAnswerQuestions = [
      {
        question: 'Create the marker?',
        header: 'Marker',
        options: [
          { label: 'Yes', description: 'Create only /tmp/marker.' },
          { label: 'No', description: 'Do not create it.' },
        ],
      },
    ];

    class AskUserQuestionTool {
      readonly name = core.ToolNames.ASK_USER_QUESTION;
      readonly kind = core.Kind.Think;
      readonly displayName = this.name;
      readonly description = this.name;
      readonly canUpdateOutput = false;
      readonly isOutputMarkdown = true;
      readonly build = vi.fn().mockReturnValue({
        params: { questions: trustedAnswerQuestions },
        execute: vi.fn().mockResolvedValue({
          llmContent:
            'User has provided the following answers:\n\n**Marker**: Yes',
        }),
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        requiresUserInteraction: vi.fn().mockReturnValue(true),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'ask_user_question',
          title: 'Please answer the following question(s):',
          questions: trustedAnswerQuestions,
          onConfirm: vi.fn().mockResolvedValue(undefined),
        }),
        getDescription: vi.fn().mockReturnValue(this.name),
        toolLocations: vi.fn().mockReturnValue([]),
      });
    }

    function useBuiltinAskUserQuestionTool() {
      mockToolRegistry.getTool.mockReturnValue(new AskUserQuestionTool());
    }

    async function runAskUserQuestion(signal = new AbortController().signal) {
      return (session as unknown as ToolCallInternals).runToolCalls(
        signal,
        'prompt-auq',
        [
          {
            id: 'call-auq',
            name: core.ToolNames.ASK_USER_QUESTION,
            args: { questions: trustedAnswerQuestions },
          },
        ],
      );
    }

    it('records an accepted built-in ask_user_question host answer', async () => {
      useBuiltinAskUserQuestionTool();
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Yes' },
      });

      await runAskUserQuestion();

      expect(mockLlmClient.recordTrustedUserAnswers).toHaveBeenCalledOnce();
      expect(mockLlmClient.recordTrustedUserAnswers).toHaveBeenCalledWith(
        'call-auq',
        trustedAnswerQuestions,
        { '0': 'Yes' },
      );
    });

    it.each([
      [
        'cancelled',
        async () => {
          vi.mocked(mockClient.requestPermission).mockResolvedValue({
            outcome: { outcome: 'cancelled' },
          });
          await runAskUserQuestion();
        },
      ],
      [
        'permission error',
        async () => {
          vi.mocked(mockClient.requestPermission).mockRejectedValue(
            new Error('host unavailable'),
          );
          await runAskUserQuestion();
        },
      ],
      [
        'aborted response',
        async () => {
          const controller = new AbortController();
          vi.mocked(mockClient.requestPermission).mockImplementation(
            async () => {
              controller.abort();
              return {
                outcome: { outcome: 'selected', optionId: 'proceed_once' },
                answers: { '0': 'Yes' },
              };
            },
          );
          await runAskUserQuestion(controller.signal);
        },
      ],
    ])(
      'does not record a %s ask_user_question response',
      async (_name, run) => {
        useBuiltinAskUserQuestionTool();
        await run();
        expect(mockLlmClient.recordTrustedUserAnswers).not.toHaveBeenCalled();
      },
    );

    it('does not trust a same-named shadow ask_user_question tool', async () => {
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          core.ToolNames.ASK_USER_QUESTION,
          vi.fn().mockResolvedValue({ llmContent: 'shadow result' }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Yes' },
      });

      await runAskUserQuestion();

      expect(mockLlmClient.recordTrustedUserAnswers).not.toHaveBeenCalled();
    });

    it('blocks standalone worktree actions before building the tool', async () => {
      recreateStandaloneSession();
      const builds: Array<ReturnType<typeof vi.fn>> = [];
      mockToolRegistry.getTool.mockImplementation((name: string) => {
        const build = vi.fn();
        builds.push(build);
        return {
          name,
          kind:
            name === core.ToolNames.AGENT ? core.Kind.Think : core.Kind.Edit,
          displayName: name,
          description: name,
          build,
          canUpdateOutput: false,
          isOutputMarkdown: true,
        };
      });

      const calls: FunctionCall[] = [
        {
          id: 'agent_isolation',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore', isolation: 'worktree' },
        },
        {
          id: 'agent_working_dir',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore', working_dir: '/tmp/other' },
        },
        {
          id: 'enter_worktree',
          name: core.ToolNames.ENTER_WORKTREE,
          args: { name: 'other' },
        },
        {
          id: 'exit_worktree',
          name: core.ToolNames.EXIT_WORKTREE,
          args: { name: 'other' },
        },
      ];

      for (const call of calls) {
        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(new AbortController().signal, `prompt-${call.id}`, [
          call,
        ]);

        expect(result.parts[0].functionResponse?.response).toEqual({
          error:
            'Standalone sessions cannot change or override their working directory.',
        });
      }
      expect(builds).toHaveLength(4);
      for (const build of builds) {
        expect(build).not.toHaveBeenCalled();
      }
    });

    it('applies the standalone working directory gate to a PreToolUse replacement', async () => {
      recreateStandaloneSession();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      vi.spyOn(core, 'firePreToolUseHook').mockResolvedValue({
        shouldProceed: true,
        updatedInput: { subagent_type: 'explore', working_dir: '/tmp/other' },
      });
      const build = vi.fn();
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-rewrite', [
        {
          id: 'agent_rewrite',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error:
          'Standalone sessions cannot change or override their working directory.',
      });
      expect(build).not.toHaveBeenCalled();
    });

    it('allows a standalone fork Agent without a cwd override', async () => {
      recreateStandaloneSession();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'fork completed',
        returnDisplay: 'fork completed',
      });
      const build = vi.fn().mockReturnValue({
        params: { subagent_type: 'fork' },
        eventEmitter: new EventEmitter(),
        execute,
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getDescription: vi.fn().mockReturnValue('Agent'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-fork-agent', [
        {
          id: 'fork_agent',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'fork', prompt: 'inspect' },
        },
      ]);

      expect(build).toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'fork completed',
      });
    });

    it('records a missing tool name as a pre-execution failure', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const before = Date.now();
      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-missing-name', [
        {
          id: 'missing_name_call',
          args: {},
        },
      ]);

      expect(mockToolRegistry.getTool).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse).toMatchObject({
        id: 'missing_name_call',
        name: 'unknown_tool',
        response: { error: 'Missing function name' },
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'missing_name_call',
          function_name: 'unknown_tool',
          status: 'error',
          execution_status: 'not_started',
          error_type: core.ToolErrorType.INVALID_TOOL_PARAMS,
        }),
      );
      const timing = logToolCallSpy.mock.calls.find(
        ([, event]) => event.call_id === 'missing_name_call',
      )?.[1];
      expect(timing?.started_at_ms).toBeGreaterThanOrEqual(before);
      expect(timing?.started_at_ms).toBeLessThanOrEqual(Date.now());
      expect(timing?.duration_ms).toBeGreaterThanOrEqual(0);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'missing_name_call',
          status: 'error',
          executionStatus: 'not_started',
          errorType: core.ToolErrorType.INVALID_TOOL_PARAMS,
        }),
      );
    });

    it('preserves cancellation when tool enablement resolves after abort', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const endToolSpanSpy = vi.spyOn(core, 'endToolSpan');
      const abortController = new AbortController();
      let resolveEnabled!: (enabled: boolean) => void;
      const isToolEnabled = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveEnabled = resolve;
          }),
      );
      mockConfig.getPermissionManager = vi.fn().mockReturnValue({
        isToolEnabled,
      });
      const execute = vi.fn();
      const build = vi.fn().mockReturnValue({
        params: {},
        execute,
        getDefaultPermission: vi.fn(),
        getDescription: vi.fn().mockReturnValue('enablement_tool'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'enablement_tool',
        kind: core.Kind.Read,
        displayName: 'enablement_tool',
        description: 'enablement_tool',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const runPromise = (session as unknown as ToolCallInternals).runToolCalls(
        abortController.signal,
        'prompt-enablement-cancel',
        [
          {
            id: 'enablement_cancel_call',
            name: 'enablement_tool',
            args: {},
          },
        ],
      );

      await vi.waitFor(() => expect(isToolEnabled).toHaveBeenCalledOnce());
      abortController.abort();
      resolveEnabled(false);
      const result = await runPromise;

      expect(build).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Tool call was cancelled before execution.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'enablement_cancel_call',
          status: 'cancelled',
          execution_status: 'not_started',
        }),
      );
      expect(endToolSpanSpy).toHaveBeenCalledWith(expect.anything(), {
        success: false,
        cancelled: true,
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'enablement_cancel_call',
          status: 'cancelled',
          executionStatus: 'not_started',
          error: undefined,
          errorType: undefined,
        }),
      );
    });

    it('preserves cancellation when permission flow resolves deny after abort', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      let resolvePermission!: (permission: 'deny') => void;
      const getDefaultPermission = vi.fn(
        () =>
          new Promise<'deny'>((resolve) => {
            resolvePermission = resolve;
          }),
      );
      const execute = vi.fn();
      const build = vi.fn().mockReturnValue({
        params: {},
        execute,
        getDefaultPermission,
        getDescription: vi.fn().mockReturnValue('permission_flow_tool'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'permission_flow_tool',
        kind: core.Kind.Read,
        displayName: 'permission_flow_tool',
        description: 'permission_flow_tool',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const runPromise = (session as unknown as ToolCallInternals).runToolCalls(
        abortController.signal,
        'prompt-permission-flow-cancel',
        [
          {
            id: 'permission_flow_cancel_call',
            name: 'permission_flow_tool',
            args: {},
          },
        ],
      );

      await vi.waitFor(() =>
        expect(getDefaultPermission).toHaveBeenCalledOnce(),
      );
      abortController.abort();
      resolvePermission('deny');
      const result = await runPromise;

      expect(build).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Tool call was cancelled before execution.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'permission_flow_cancel_call',
          status: 'cancelled',
          execution_status: 'not_started',
        }),
      );
      const event = logToolCallSpy.mock.calls.at(-1)?.[1];
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('error_type');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'permission_flow_cancel_call',
          status: 'cancelled',
          executionStatus: 'not_started',
          error: undefined,
          errorType: undefined,
        }),
      );
    });

    it('records one successful terminal when ACP updates fail', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      vi.mocked(mockClient.sessionUpdate).mockRejectedValue(
        new Error('ACP update unavailable'),
      );
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'completed',
        returnDisplay: 'completed',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('success_tool', execute),
      );

      const before = Date.now();
      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-success', [
        { id: 'success_call', name: 'success_tool', args: {} },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'completed',
      });
      expect(logToolCallSpy).toHaveBeenCalledTimes(1);
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'success_call',
          status: 'success',
          execution_status: 'success',
        }),
      );
      const timing = logToolCallSpy.mock.calls.find(
        ([, event]) => event.call_id === 'success_call',
      )?.[1];
      expect(timing?.started_at_ms).toBeGreaterThanOrEqual(before);
      expect(timing?.started_at_ms).toBeLessThanOrEqual(Date.now());
      expect(timing?.duration_ms).toBeGreaterThanOrEqual(0);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledTimes(
        1,
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'success_call',
          status: 'success',
          executionStatus: 'success',
        }),
      );
    });

    it('records execution-stage cancellation on both axes', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const endExecutionSpanSpy = vi.spyOn(core, 'endToolExecutionSpan');
      const endToolSpanSpy = vi.spyOn(core, 'endToolSpan');
      const abortController = new AbortController();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockImplementation(async () => {
        abortController.abort();
        return {
          llmContent: 'partial output',
          returnDisplay: 'partial output',
        };
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('cancel_tool', execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(abortController.signal, 'prompt-execution-cancel', [
        { id: 'execution_cancel_call', name: 'cancel_tool', args: {} },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'The tool had already completed; its output was discarded.',
      });
      expect(endExecutionSpanSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          executionStatus: 'cancelled',
          cancelled: true,
        }),
      );
      expect(endToolSpanSpy).toHaveBeenCalledWith(expect.anything(), {
        success: false,
        cancelled: true,
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'execution_cancel_call',
          status: 'cancelled',
          execution_status: 'cancelled',
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'execution_cancel_call',
          status: 'cancelled',
          executionStatus: 'cancelled',
          error: undefined,
          errorType: undefined,
        }),
      );
    });

    it('reports a returned interruption as interrupted and keeps its output', async () => {
      const abortController = new AbortController();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockImplementation(async () => {
        abortController.abort();
        return {
          llmContent: 'Below is the output before it was cancelled.\npartial',
          returnDisplay: 'partial',
          interruptedBeforeCompletion: true,
        };
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('cancel_tool', execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(abortController.signal, 'prompt-interrupted-cancel', [
        { id: 'interrupted_cancel_call', name: 'cancel_tool', args: {} },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error:
          'User intentionally cancelled this tool call. Stop and await further instructions; do not retry or work around it.\n\nBelow is the output before it was cancelled.\npartial',
      });
    });

    it('does not execute after cancellation settles during PreToolUse', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      let resolvePreHook:
        | ((value: { success: true; output: { decision: 'allow' } }) => void)
        | undefined;
      const preHookPromise = new Promise<{
        success: true;
        output: { decision: 'allow' };
      }>((resolve) => {
        resolvePreHook = resolve;
      });
      const messageBus = {
        request: vi.fn().mockReturnValue(preHookPromise),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('pre_hook_tool', execute),
      );

      const runPromise = (session as unknown as ToolCallInternals).runToolCalls(
        abortController.signal,
        'prompt-pre-hook-cancel',
        [
          {
            id: 'pre_hook_cancel_call',
            name: 'pre_hook_tool',
            args: {},
          },
        ],
      );

      await vi.waitFor(() => expect(messageBus.request).toHaveBeenCalledOnce());
      abortController.abort();
      resolvePreHook?.({
        success: true,
        output: { decision: 'allow' },
      });
      const result = await runPromise;

      expect(execute).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Tool call was cancelled before execution.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'pre_hook_cancel_call',
          status: 'cancelled',
          execution_status: 'not_started',
        }),
      );
      const event = logToolCallSpy.mock.calls.at(-1)?.[1];
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('error_type');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'pre_hook_cancel_call',
          status: 'cancelled',
          executionStatus: 'not_started',
          error: undefined,
          errorType: undefined,
        }),
      );
    });

    it('preserves cancellation while emitting a PreToolUse block message', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      let markBlockMessageStarted!: () => void;
      const blockMessageStarted = new Promise<void>((resolve) => {
        markBlockMessageStarted = resolve;
      });
      let releaseBlockMessage!: () => void;
      const blockMessageRelease = new Promise<void>((resolve) => {
        releaseBlockMessage = resolve;
      });
      vi.mocked(mockClient.sessionUpdate).mockImplementation(async (params) => {
        if (
          params.update.sessionUpdate === 'agent_message_chunk' &&
          params.update.content.type === 'text' &&
          params.update.content.text.includes('PreToolUse blocked')
        ) {
          markBlockMessageStarted();
          await blockMessageRelease;
        }
      });
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: { decision: 'deny', reason: 'blocked by test hook' },
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn();
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('blocked_tool', execute),
      );

      const runPromise = (session as unknown as ToolCallInternals).runToolCalls(
        abortController.signal,
        'prompt-block-message-cancel',
        [
          {
            id: 'block_message_cancel_call',
            name: 'blocked_tool',
            args: {},
          },
        ],
      );

      await blockMessageStarted;
      abortController.abort();
      releaseBlockMessage();
      const result = await runPromise;

      expect(execute).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Tool call was cancelled before execution.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'block_message_cancel_call',
          status: 'cancelled',
          execution_status: 'not_started',
        }),
      );
      const event = logToolCallSpy.mock.calls.at(-1)?.[1];
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('error_type');
    });

    it('does not execute after cancellation settles during the start emitter', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const startExecutionSpanSpy = vi.spyOn(core, 'startToolExecutionSpan');
      const abortController = new AbortController();
      let resolveStart: (() => void) | undefined;
      vi.mocked(mockClient.sessionUpdate).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStart = resolve;
          }),
      );
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('start_emitter_tool', execute),
      );

      const runPromise = (session as unknown as ToolCallInternals).runToolCalls(
        abortController.signal,
        'prompt-start-emitter-cancel',
        [
          {
            id: 'start_emitter_cancel_call',
            name: 'start_emitter_tool',
            args: {},
          },
        ],
      );

      await vi.waitFor(() =>
        expect(mockClient.sessionUpdate).toHaveBeenCalledOnce(),
      );
      abortController.abort();
      resolveStart?.();
      const result = await runPromise;

      expect(execute).not.toHaveBeenCalled();
      expect(startExecutionSpanSpy).not.toHaveBeenCalled();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Tool call was cancelled before execution.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'start_emitter_cancel_call',
          status: 'cancelled',
          execution_status: 'not_started',
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'start_emitter_cancel_call',
          status: 'cancelled',
          executionStatus: 'not_started',
        }),
      );
    });

    it('keeps a structured timeout exception ahead of a later parent abort', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const endExecutionSpanSpy = vi.spyOn(core, 'endToolExecutionSpan');
      const abortController = new AbortController();
      const timeoutError = Object.assign(new Error('MCP request timed out'), {
        errorType: core.ToolErrorType.EXECUTION_TIMEOUT,
      });
      const execute = vi.fn().mockImplementation(
        () =>
          new Promise<core.ToolResult>((_resolve, reject) => {
            reject(timeoutError);
            abortController.abort();
          }),
      );
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('timeout_tool', execute),
      );
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const messageBus = {
        request: vi
          .fn()
          .mockImplementation(async (request: { eventName?: string }) => ({
            success: true,
            output:
              request.eventName === 'PreToolUse' ? { decision: 'allow' } : {},
          })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(abortController.signal, 'prompt-structured-timeout', [
        {
          id: 'structured_timeout_call',
          name: 'timeout_tool',
          args: {},
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'MCP request timed out',
      });
      expect(endExecutionSpanSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          executionStatus: 'error',
          errorType: core.ToolErrorType.EXECUTION_TIMEOUT,
          cancelled: false,
        }),
      );
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'structured_timeout_call',
          status: 'error',
          execution_status: 'error',
          error_type: core.ToolErrorType.EXECUTION_TIMEOUT,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'structured_timeout_call',
          status: 'error',
          executionStatus: 'error',
          errorType: core.ToolErrorType.EXECUTION_TIMEOUT,
        }),
      );
      expect(result.repeatedToolFailureBatch).toEqual({
        complete: true,
        observations: [
          expect.objectContaining({
            callId: 'structured_timeout_call',
            policyToolName: 'timeout_tool',
            terminalStatus: 'error',
            executionStatus: 'error',
            executionErrorType: core.ToolErrorType.EXECUTION_TIMEOUT,
          }),
        ],
      });
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'PostToolUseFailure',
          input: expect.objectContaining({ is_interrupt: false }),
        }),
        expect.anything(),
      );
    });

    it('records PostToolUse stop as an error after successful execution', async () => {
      const lifecycleUpdates = vi.spyOn(session, 'sendUpdate');
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const boundarySpy = vi
        .spyOn(core, 'observeToolResultBoundary')
        .mockReturnValue(false);
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
                    stopReason: 'Stopped by hook',
                  }
                : { decision: 'allow' },
          })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const artifacts = [
        {
          kind: 'link' as const,
          title: 'Completed report',
          url: 'https://example.com/report',
        },
      ];
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'completed',
        returnDisplay: 'completed',
        artifacts,
        persistedOutputFiles: ['/private/post-stop-output.txt'],
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('post_stop_tool', execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-post-stop', [
        { id: 'post_stop_call', name: 'post_stop_tool', args: {} },
      ]);

      expect(
        lifecycleUpdates.mock.calls
          .map(([update]) => update._meta?.['toolLifecycle'])
          .filter(Boolean),
      ).toEqual([
        expect.objectContaining({ phase: 'started' }),
        expect.objectContaining({
          phase: 'ended',
          executionStatus: 'success',
          outcome: 'error',
          executionDurationMs: expect.any(Number),
        }),
      ]);
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Stopped by hook',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'post_stop_call',
          status: 'error',
          execution_status: 'success',
          error_type: core.ToolErrorType.EXECUTION_DENIED,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'post_stop_call',
          status: 'error',
          executionStatus: 'success',
          errorType: core.ToolErrorType.EXECUTION_DENIED,
          resultDisplay: undefined,
          artifacts,
          persistedOutputFiles: ['/private/post-stop-output.txt'],
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            toolCallId: 'post_stop_call',
            _meta: expect.objectContaining({ artifacts }),
          }),
        }),
      );
      const producerObservations = boundarySpy.mock.calls.filter(
        ([observation]) =>
          observation.stage === 'producer' &&
          observation.toolCallId === 'post_stop_call',
      );
      expect(producerObservations).toHaveLength(1);
      expect(producerObservations[0][0].artifacts).toEqual([
        { state: 'reusable', kinds: ['file', 'link'] },
      ]);
    });

    it('records postprocessing failure after successful execution', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'completed',
        returnDisplay: 'completed',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('postprocess_tool', execute),
      );
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      bridgeToolResultImagesSpy.mockRejectedValueOnce(
        new Error('image postprocessing failed'),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-postprocess-fail', [
        {
          id: 'postprocess_success_call',
          name: 'postprocess_tool',
          args: {},
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'image postprocessing failed',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'postprocess_success_call',
          status: 'error',
          execution_status: 'success',
          error_type: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'postprocess_success_call',
          status: 'error',
          executionStatus: 'success',
          errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(result.repeatedToolFailureBatch).toEqual({
        complete: true,
        observations: [
          expect.objectContaining({
            callId: 'postprocess_success_call',
            policyToolName: 'postprocess_tool',
            terminalStatus: 'error',
            executionStatus: 'success',
            executionErrorType: undefined,
          }),
        ],
      });
    });

    it('preserves a structured postprocessing error type after successful execution', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'completed',
        returnDisplay: 'completed',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('structured_postprocess_tool', execute),
      );
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      bridgeToolResultImagesSpy.mockRejectedValueOnce(
        Object.assign(new Error('structured postprocessing failure'), {
          errorType: core.ToolErrorType.EXECUTION_FAILED,
        }),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-structured-post', [
        {
          id: 'structured_postprocess_call',
          name: 'structured_postprocess_tool',
          args: {},
        },
      ]);

      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'structured_postprocess_call',
          status: 'error',
          execution_status: 'success',
          error_type: core.ToolErrorType.EXECUTION_FAILED,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          status: 'error',
          executionStatus: 'success',
          errorType: core.ToolErrorType.EXECUTION_FAILED,
        }),
      );
    });

    it('records cancellation when abort arrives during exception failure hooks', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      const messageBus = {
        request: vi
          .fn()
          .mockImplementation(async (request: { eventName?: string }) => {
            if (request.eventName === 'PostToolUseFailure') {
              abortController.abort();
            }
            return {
              success: true,
              output:
                request.eventName === 'PreToolUse' ? { decision: 'allow' } : {},
            };
          }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(
          'cancel_during_failure_hook_tool',
          vi.fn().mockRejectedValue(new Error('tool failed')),
        ),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(abortController.signal, 'prompt-failure-hook-cancel', [
        {
          id: 'failure_hook_cancel_call',
          name: 'cancel_during_failure_hook_tool',
          args: {},
        },
      ]);

      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'failure_hook_cancel_call',
          status: 'cancelled',
          execution_status: 'error',
        }),
      );
      expect(logToolCallSpy.mock.calls[0][1]).not.toHaveProperty('error_type');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          status: 'cancelled',
          executionStatus: 'error',
          errorType: undefined,
        }),
      );
    });

    it('records one terminal when failure hooks and ACP updates fail', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const boundarySpy = vi
        .spyOn(core, 'observeToolResultBoundary')
        .mockReturnValue(false);
      vi.mocked(mockClient.sessionUpdate).mockRejectedValue(
        new Error('ACP update unavailable'),
      );
      const messageBus = {
        request: vi
          .fn()
          .mockImplementation(async (request: { eventName?: string }) => {
            if (request.eventName === 'PostToolUseFailure') {
              throw new Error('failure hook unavailable');
            }
            return { success: true, output: { decision: 'allow' } };
          }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockRejectedValue(new Error('tool failed'));
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('failing_tool', execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-hook-fail', [
        { id: 'hook_fail_call', name: 'failing_tool', args: {} },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'tool failed',
      });
      expect(logToolCallSpy).toHaveBeenCalledTimes(1);
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'hook_fail_call',
          status: 'error',
          execution_status: 'error',
          error_type: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledTimes(
        1,
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'hook_fail_call',
          status: 'error',
          executionStatus: 'error',
          errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(boundarySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'producer',
          sessionId: 'test-session-id',
          promptId: 'prompt-hook-fail',
          toolCallId: 'hook_fail_call',
          toolName: 'failing_tool',
          values: expect.any(Function),
        }),
      );
    });

    it('observes a producer error when a settled tool result is malformed', async () => {
      const boundarySpy = vi
        .spyOn(core, 'observeToolResultBoundary')
        .mockReturnValue(false);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('malformed_tool', vi.fn().mockResolvedValue(null)),
      );

      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-malformed-result',
        [
          {
            id: 'malformed_result_call',
            name: 'malformed_tool',
            args: {},
          },
        ],
      );

      const producerObservations = boundarySpy.mock.calls.filter(
        ([observation]) =>
          observation.stage === 'producer' &&
          observation.toolCallId === 'malformed_result_call',
      );
      expect(producerObservations).toHaveLength(1);
      expect(producerObservations[0][0]).toEqual(
        expect.objectContaining({
          sessionId: 'test-session-id',
          promptId: 'prompt-malformed-result',
          toolName: 'malformed_tool',
          values: expect.any(Function),
        }),
      );
    });

    it('ignores throwing optional metadata on a successful tool result', async () => {
      const toolResult = {
        llmContent: 'completed',
        returnDisplay: 'completed',
      } as core.ToolResult;
      Object.defineProperties(toolResult, {
        artifacts: {
          get: () => {
            throw new Error('artifacts unavailable');
          },
        },
        persistedOutputFiles: {
          get: () => {
            throw new Error('persisted output unavailable');
          },
        },
      });
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(
          'throwing_metadata_tool',
          vi.fn().mockResolvedValue(toolResult),
        ),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-metadata', [
        {
          id: 'throwing_metadata_call',
          name: 'throwing_metadata_tool',
          args: {},
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'completed',
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'throwing_metadata_call',
          status: 'success',
          artifacts: undefined,
          persistedOutputFiles: undefined,
        }),
      );
    });

    it('classifies postprocessing failures independently from a settled soft error', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const endExecutionSpanSpy = vi.spyOn(core, 'endToolExecutionSpan');
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'timed out',
        returnDisplay: 'timed out',
        error: {
          message: 'execution timed out',
          type: core.ToolErrorType.EXECUTION_TIMEOUT,
        },
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('timeout_tool', execute),
      );
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      bridgeToolResultImagesSpy.mockRejectedValueOnce(
        new Error('image postprocessing failed'),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-postprocess-error', [
        {
          id: 'postprocess_error_call',
          name: 'timeout_tool',
          args: {},
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'image postprocessing failed',
      });
      expect(endExecutionSpanSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          executionStatus: 'error',
          errorType: core.ToolErrorType.EXECUTION_TIMEOUT,
        }),
      );
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'postprocess_error_call',
          status: 'error',
          execution_status: 'error',
          error: 'image postprocessing failed',
          error_type: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'postprocess_error_call',
          status: 'error',
          executionStatus: 'error',
          errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(result.repeatedToolFailureBatch).toEqual({
        complete: true,
        observations: [
          expect.objectContaining({
            callId: 'postprocess_error_call',
            policyToolName: 'timeout_tool',
            terminalStatus: 'error',
            executionStatus: 'error',
            executionErrorType: core.ToolErrorType.EXECUTION_TIMEOUT,
          }),
        ],
      });
    });

    it.each([
      {
        label: 'successful execution',
        toolResult: {
          llmContent: 'completed output',
          returnDisplay: 'completed output',
        },
        executionStatus: 'success' as const,
      },
      {
        label: 'soft execution failure',
        toolResult: {
          llmContent: 'failed output',
          returnDisplay: 'failed output',
          error: {
            message: 'tool failed',
            type: core.ToolErrorType.EXECUTION_FAILED,
          },
        },
        executionStatus: 'error' as const,
      },
      {
        label: 'soft execution timeout',
        toolResult: {
          llmContent: 'timed out output',
          returnDisplay: 'timed out output',
          error: {
            message: 'tool timed out',
            type: core.ToolErrorType.EXECUTION_TIMEOUT,
          },
        },
        executionStatus: 'error' as const,
      },
    ])(
      'replaces $label output when image postprocessing is cancelled',
      async ({ toolResult, executionStatus }) => {
        const logToolCallSpy = vi
          .spyOn(core, 'logToolCall')
          .mockImplementation(() => {});
        const abortController = new AbortController();
        const execute = vi.fn().mockResolvedValue(toolResult);
        mockToolRegistry.getTool.mockReturnValue(
          mockAllowedTool('bridge_cancel_tool', execute),
        );
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
        bridgeToolResultImagesSpy.mockImplementationOnce(
          async ({ responseParts }: { responseParts: Part[] }) => {
            abortController.abort();
            return responseParts;
          },
        );

        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(
          abortController.signal,
          `prompt-bridge-cancel-${executionStatus}`,
          [
            {
              id: `bridge_cancel_${executionStatus}`,
              name: 'bridge_cancel_tool',
              args: {},
            },
          ],
        );

        expect(result.parts[0].functionResponse?.response).toEqual({
          error: 'The tool had already completed; its output was discarded.',
        });
        expect(logToolCallSpy).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            call_id: `bridge_cancel_${executionStatus}`,
            status: 'cancelled',
            execution_status: executionStatus,
          }),
        );
        const event = logToolCallSpy.mock.calls.at(-1)?.[1];
        expect(event).not.toHaveProperty('error');
        expect(event).not.toHaveProperty('error_type');
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          result.parts,
          expect.objectContaining({
            callId: `bridge_cancel_${executionStatus}`,
            status: 'cancelled',
            executionStatus,
            error: undefined,
            errorType: undefined,
          }),
        );
      },
    );

    it('prefers cancellation when PostToolUse stops after execution settles', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const abortController = new AbortController();
      const messageBus = {
        request: vi
          .fn()
          .mockImplementation(async (request: { eventName?: string }) => {
            if (request.eventName === 'PostToolUse') {
              abortController.abort();
              return {
                success: true,
                output: {
                  decision: 'allow',
                  continue: false,
                  stopReason: 'Stopping per hook request',
                },
              };
            }
            return { success: true, output: { decision: 'allow' } };
          }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const artifacts = [
        {
          kind: 'file' as const,
          title: 'Cancelled report',
          workspacePath: 'reports/cancelled.txt',
        },
      ];
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'completed',
        returnDisplay: 'completed',
        artifacts,
        persistedOutputFiles: ['/private/post-cancel-output.txt'],
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('post_hook_tool', execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(abortController.signal, 'prompt-post-hook-cancel', [
        {
          id: 'post_hook_cancel_call',
          name: 'post_hook_tool',
          args: {},
        },
      ]);

      expect(execute).toHaveBeenCalledOnce();
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'The tool had already completed; its output was discarded.',
      });
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'post_hook_cancel_call',
          status: 'cancelled',
          execution_status: 'success',
        }),
      );
      const event = logToolCallSpy.mock.calls.at(-1)?.[1];
      expect(event).not.toHaveProperty('error');
      expect(event).not.toHaveProperty('error_type');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          callId: 'post_hook_cancel_call',
          status: 'cancelled',
          executionStatus: 'success',
          error: undefined,
          errorType: undefined,
          resultDisplay: undefined,
          artifacts,
          persistedOutputFiles: ['/private/post-cancel-output.txt'],
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            toolCallId: 'post_hook_cancel_call',
            _meta: expect.objectContaining({ artifacts }),
          }),
        }),
      );
    });

    it('publishes a persisted Todo plan when cancellation races completion', async () => {
      const controller = new AbortController();
      const execute = vi.fn().mockImplementation(async () => {
        controller.abort();
        return {
          llmContent: 'updated',
          returnDisplay: {
            type: 'todo_list',
            planId: 'plan-1',
            todos: [{ id: '1', content: 'Ship', status: 'pending' }],
          },
        };
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.TODO_WRITE, execute),
      );

      await (session as unknown as ToolCallInternals).runToolCalls(
        controller.signal,
        'prompt-cancelled-todo',
        [
          {
            id: 'todo-call',
            name: core.ToolNames.TODO_WRITE,
            args: { todos: [{ id: '1', content: 'Ship', status: 'pending' }] },
          },
        ],
      );

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'plan',
            entries: [
              expect.objectContaining({
                content: 'Ship',
                _meta: { qwenTodo: { id: '1' } },
              }),
            ],
          }),
        }),
      );
    });

    it('lets normalized tool images select a full-turn model', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: [
          { text: 'captured screen' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'aW1hZ2U=',
            },
          },
        ],
        returnDisplay: 'captured screen',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('screenshot_tool', execute),
      );
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const onFullTurnModel = vi.fn().mockReturnValue(true);
      bridgeToolResultImagesSpy.mockImplementationOnce(
        async ({
          responseParts,
          onFullTurnModel: selectFullTurnModel,
          onVisionBridgeNotice,
        }: {
          responseParts: Part[];
          onFullTurnModel?: (model: string) => boolean;
          onVisionBridgeNotice?: (notice: string) => void;
        }) => {
          expect(selectFullTurnModel?.('qwen3-vl-plus\0')).toBe(true);
          onVisionBridgeNotice?.('Routing this image turn to qwen3-vl-plus.');
          return responseParts;
        },
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-tool-image',
        [
          {
            id: 'call-screen',
            name: 'screenshot_tool',
            args: {},
          },
        ],
        undefined,
        onFullTurnModel,
      );

      expect(execute).toHaveBeenCalledOnce();
      expect(bridgeToolResultImagesSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: mockConfig,
          responseParts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-screen',
                name: 'screenshot_tool',
                parts: [
                  expect.objectContaining({
                    inlineData: expect.objectContaining({
                      mimeType: 'image/png',
                    }),
                  }),
                ],
              }),
            }),
          ],
          signal: expect.any(AbortSignal),
          onFullTurnModel,
        }),
      );
      expect(onFullTurnModel).toHaveBeenCalledWith('qwen3-vl-plus\0');
      expect(result.parts[0].functionResponse?.parts).toHaveLength(1);
      expect(agentMessageChunks()).toContain(
        'Routing this image turn to qwen3-vl-plus.',
      );
    });

    it('keeps a full-turn model selected across parallel tool images', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: [
          { text: 'captured screen' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
        returnDisplay: 'captured screen',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('screenshot_tool', execute),
      );
      const selections: boolean[] = [];
      bridgeToolResultImagesSpy.mockImplementation(
        async ({
          responseParts,
          onFullTurnModel: selectFullTurnModel,
        }: {
          responseParts: Part[];
          onFullTurnModel?: (model: string) => boolean;
        }) => {
          selections.push(selectFullTurnModel?.('qwen3-vl-plus\0') ?? false);
          return responseParts;
        },
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  { id: 'call-screen-1', name: 'screenshot_tool', args: {} },
                  { id: 'call-screen-2', name: 'screenshot_tool', args: {} },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'capture two screens' }],
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(selections).toHaveLength(2);
      expect(selections.every((accepted) => accepted)).toBe(true);
    });

    it('keeps a full-turn model selected in a Stop hook continuation', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const runtimeView = {
        contentGenerator: {},
        contentGeneratorConfig: {
          model: 'qwen3-vl-plus',
          modalities: { image: true },
        },
        model: 'qwen3-vl-plus',
      };
      const resolveForModel = vi.fn().mockResolvedValue(runtimeView);
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue({
        resolveForModel,
      });
      const execute = vi.fn().mockResolvedValue({
        llmContent: [
          { text: 'captured screen' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        ],
        returnDisplay: 'captured screen',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('screenshot_tool', execute),
      );
      const selections: boolean[] = [];
      bridgeToolResultImagesSpy.mockImplementation(
        async ({
          responseParts,
          onFullTurnModel: selectFullTurnModel,
        }: {
          responseParts: Part[];
          onFullTurnModel?: (model: string) => boolean;
        }) => {
          selections.push(selectFullTurnModel?.('qwen3-vl-plus\0') ?? false);
          return responseParts;
        },
      );
      let stopHookRequestCount = 0;
      const messageBus = {
        request: vi
          .fn()
          .mockImplementation(async (request: { eventName?: string }) => {
            if (request.eventName !== 'Stop') {
              return { success: true, output: {} };
            }
            stopHookRequestCount++;
            return stopHookRequestCount === 1
              ? {
                  success: true,
                  output: {
                    decision: 'block',
                    reason: 'Inspect another screen',
                  },
                }
              : { success: true, output: {} };
          }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((eventName: string) => eventName === 'Stop');
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
      mockChat.getLastModelMessageText = vi
        .fn()
        .mockReturnValue('captured screen');
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-screen-main',
                    name: 'screenshot_tool',
                    args: {},
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-screen-stop',
                    name: 'screenshot_tool',
                    args: {},
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'capture screens until done' }],
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(selections).toEqual([true, true]);
      expect(stopHookRequestCount).toBe(2);
      expect(resolveForModel).toHaveBeenCalledWith('qwen3-vl-plus', {
        failClosed: true,
      });
    });

    it('uses the provider tool-call id for the GenAI field only', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'read',
        returnDisplay: 'read',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.READ_FILE, execute),
      );
      const [normalized] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'provider-call',
              name: core.ToolNames.READ_FILE,
              args: { file_path: 'test.ts' },
            },
          },
        ],
        new Set(['provider-call']),
        new Set(),
      );

      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-tool-span',
        [normalized.functionCall!],
      );

      expect(startToolSpanSpy).toHaveBeenCalledWith(
        core.ToolNames.READ_FILE,
        expect.objectContaining({
          'tool.call_id': 'provider-call__qwen_dup_2',
          call_id: 'provider-call__qwen_dup_2',
          'gen_ai.tool.call.id': 'provider-call',
        }),
        'read_file',
        'prompt-tool-span',
      );
      expect(addToolArgumentsAttributesSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.anything(),
        {},
      );
      expect(addToolCallResultAttributesSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.anything(),
        { output: 'read' },
      );

      startToolSpanSpy.mockClear();
      addToolArgumentsAttributesSpy.mockClear();
      addToolCallResultAttributesSpy.mockClear();
      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-tool-span-fallback',
        [
          {
            id: 'internal-call',
            name: core.ToolNames.READ_FILE,
            args: { file_path: 'test.ts' },
          },
        ],
      );
      expect(startToolSpanSpy).toHaveBeenCalledWith(
        core.ToolNames.READ_FILE,
        expect.objectContaining({
          'tool.call_id': 'internal-call',
          'gen_ai.tool.call.id': 'internal-call',
        }),
        'read_file',
        'prompt-tool-span-fallback',
      );
    });

    it('passes the transcript call id to monitor invocations', async () => {
      const setCallId = vi.fn();
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'monitor started',
        returnDisplay: 'monitor started',
      });
      const tool = mockAllowedTool(core.ToolNames.MONITOR, execute);
      tool.build.mockReturnValue({
        ...tool.build(),
        setCallId,
      });
      mockToolRegistry.getTool.mockReturnValue(tool);

      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-monitor-correlation',
        [
          {
            id: 'monitor-call',
            name: core.ToolNames.MONITOR,
            args: { command: 'tail -f app.log' },
          },
        ],
      );

      expect(setCallId).toHaveBeenCalledWith('monitor-call');
      expect(execute).toHaveBeenCalledOnce();
      expect(setCallId.mock.invocationCallOrder[0]!).toBeLessThan(
        execute.mock.invocationCallOrder[0]!,
      );
    });

    it('does not fail ACP tool execution when telemetry helpers throw', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'read',
        returnDisplay: 'read',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.READ_FILE, execute),
      );
      addToolArgumentsAttributesSpy.mockImplementationOnce(() => {
        throw new Error('arguments telemetry failed');
      });
      addToolCallResultAttributesSpy.mockImplementationOnce(() => {
        throw new Error('result telemetry failed');
      });

      await expect(
        (session as unknown as ToolCallInternals).runToolCalls(
          new AbortController().signal,
          'prompt-tool-telemetry-failure',
          [
            {
              id: 'internal-call',
              name: core.ToolNames.READ_FILE,
              args: { file_path: 'test.ts' },
            },
          ],
        ),
      ).resolves.toBeDefined();

      expect(execute).toHaveBeenCalledOnce();
      expect(debugLoggerDebugSpy).toHaveBeenCalledWith(
        '[Session.runTool] Failed to record tool arguments telemetry',
      );
      expect(debugLoggerDebugSpy).toHaveBeenCalledWith(
        '[Session.runTool] Failed to record tool result telemetry',
      );
    });

    it('isolates enter_plan_mode from executable ACP siblings while preserving duplicate responses', async () => {
      const writeExecute = vi.fn().mockResolvedValue({
        llmContent: 'wrote',
        returnDisplay: 'wrote',
      });
      const enterExecute = vi.fn().mockResolvedValue({
        llmContent: 'entered plan mode',
        returnDisplay: 'entered plan mode',
      });
      const readExecute = vi.fn().mockResolvedValue({
        llmContent: 'read',
        returnDisplay: 'read',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) => {
        const execute =
          name === core.ToolNames.ENTER_PLAN_MODE
            ? enterExecute
            : name === core.ToolNames.WRITE_FILE
              ? writeExecute
              : readExecute;
        return mockAllowedTool(name, execute);
      });
      const historyIds = new Set(['duplicate_read']);
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([
          [
            'duplicate_read',
            core.getToolCallFingerprint(core.ToolNames.READ_FILE, {
              file_path: 'duplicate.ts',
            }),
          ],
        ]),
      );
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'duplicate_read',
              name: core.ToolNames.READ_FILE,
              args: { file_path: 'duplicate.ts' },
            },
          },
        ],
        historyIds,
        new Set<string>(),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-plan-boundary', [
        {
          id: 'write_before_entry',
          name: core.ToolNames.WRITE_FILE,
          args: { file_path: 'before.txt' },
        },
        duplicatePart.functionCall!,
        {
          id: 'enter_plan',
          name: core.ToolNames.ENTER_PLAN_MODE,
          args: {},
        },
        {
          id: 'read_after_entry',
          name: core.ToolNames.READ_FILE,
          args: { file_path: 'after.ts' },
        },
      ]);

      expect(writeExecute).not.toHaveBeenCalled();
      expect(enterExecute).toHaveBeenCalledOnce();
      expect(readExecute).not.toHaveBeenCalled();
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'write_before_entry',
        'duplicate_read__qwen_dup_2',
        'enter_plan',
        'read_after_entry',
      ]);
      expect(result.parts[0].functionResponse?.response).toEqual({
        error: core.PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
      });
      expect(result.parts[1].functionResponse?.response).toEqual({
        error: expect.stringContaining(
          'Duplicate provider tool call id "duplicate_read"',
        ),
      });
      expect(result.parts[2].functionResponse?.response).toEqual({
        output: 'entered plan mode',
      });
      expect(result.parts[3].functionResponse?.response).toEqual({
        error: core.PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE,
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[0]],
        expect.objectContaining({
          callId: 'write_before_entry',
          status: 'error',
          errorType: core.ToolErrorType.EXECUTION_DENIED,
        }),
      );
    });

    it('keeps a structured timeout as an error after a later parent abort', async () => {
      const parentController = new AbortController();
      const messageBus = {
        request: vi.fn().mockResolvedValue({ success: true, output: {} }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      const execute = vi.fn().mockImplementation(
        () =>
          new Promise<core.ToolResult>((resolve) => {
            resolve({
              llmContent: 'Command timed out.\npartial output',
              returnDisplay: 'Command timed out.\npartial output',
              error: {
                message: 'Command timed out.',
                type: core.ToolErrorType.EXECUTION_TIMEOUT,
              },
            });
            parentController.abort();
          }),
      );
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.READ_FILE, execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(parentController.signal, 'prompt-timeout', [
        {
          id: 'timeout_call',
          name: core.ToolNames.READ_FILE,
          args: { file_path: 'a.ts' },
        },
      ]);

      expect(result.parts[0].functionResponse?.response).toEqual({
        error: 'Command timed out.\npartial output',
      });
      expect(result.parts[0].functionResponse?.response).not.toHaveProperty(
        'output',
      );
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'PostToolUseFailure',
          input: expect.objectContaining({ is_interrupt: false }),
        }),
        expect.anything(),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        result.parts,
        expect.objectContaining({
          status: 'error',
          errorType: core.ToolErrorType.EXECUTION_TIMEOUT,
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: 'failed' }),
        }),
      );
    });

    it('refreshes managed memory instructions after successful ACP tool writes', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'wrote memory',
        returnDisplay: 'wrote memory',
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.WRITE_FILE, execute),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-memory-write', [
        {
          id: 'write_memory',
          name: core.ToolNames.WRITE_FILE,
          args: { file_path: '/workspace/.qwen/memory/project.md' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(refreshMemoryAfterManagedWriteSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemoryAfterManagedWriteSpy).toHaveBeenCalledWith(
        mockConfig,
        [
          {
            toolName: core.ToolNames.WRITE_FILE,
            args: { file_path: '/workspace/.qwen/memory/project.md' },
            status: 'success',
          },
        ],
        {
          logContext: 'ACP session test-session-id memory tool batch',
        },
      );
    });

    async function markAcpContextRefreshIntent() {
      vi.mocked(
        nonInteractiveCliCommands.handleSlashCommand,
      ).mockResolvedValueOnce({
        type: 'submit_prompt',
        content: [{ text: 'Remember this fact.' }],
        refreshContextFilesOnWrite: true,
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/remember fact' }],
      });
    }

    function allowAcpWriteFile() {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'wrote file',
        returnDisplay: 'wrote file',
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.WRITE_FILE, execute),
      );
    }

    async function runAcpWriteFile(
      filePath: string,
      promptId: string,
      callId = 'write_context',
    ) {
      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        promptId,
        [
          {
            id: callId,
            name: core.ToolNames.WRITE_FILE,
            args: { file_path: filePath },
          },
        ],
      );
    }

    it('refreshes context-file instructions after ACP bare remember writes QWEN.md', async () => {
      await markAcpContextRefreshIntent();
      refreshMemoryAfterManagedWriteSpy.mockClear();
      refreshMemoryInstructionSpy.mockClear();

      allowAcpWriteFile();
      await runAcpWriteFile('/repo/QWEN.md', 'prompt-context-write');

      expect(refreshMemoryAfterManagedWriteSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemoryInstructionSpy).toHaveBeenCalledWith(mockConfig, {
        logContext:
          'ACP session test-session-id context-file memory tool batch',
      });
    });

    it('keeps refreshing context-file instructions for later ACP writes in a marked turn', async () => {
      await markAcpContextRefreshIntent();
      refreshMemoryInstructionSpy.mockClear();

      allowAcpWriteFile();
      await runAcpWriteFile(
        '/repo/QWEN.md',
        'prompt-context-write-1',
        'write_context_1',
      );
      await runAcpWriteFile(
        '/repo/QWEN.md',
        'prompt-context-write-2',
        'write_context_2',
      );

      expect(refreshMemoryInstructionSpy).toHaveBeenCalledTimes(2);
    });

    it('does not refresh context-file instructions for marked ACP writes to other files', async () => {
      await markAcpContextRefreshIntent();
      refreshMemoryAfterManagedWriteSpy.mockClear();
      refreshMemoryInstructionSpy.mockClear();

      allowAcpWriteFile();
      await runAcpWriteFile(
        '/repo/notes.md',
        'prompt-notes-write',
        'write_notes',
      );

      expect(refreshMemoryAfterManagedWriteSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemoryInstructionSpy).not.toHaveBeenCalled();
    });

    it('clears unmatched context-file refresh intent on the next ordinary ACP turn', async () => {
      await markAcpContextRefreshIntent();
      allowAcpWriteFile();
      await runAcpWriteFile(
        '/repo/notes.md',
        'prompt-notes-write',
        'write_notes',
      );

      refreshMemoryInstructionSpy.mockClear();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ordinary turn' }],
      });
      await runAcpWriteFile('/repo/QWEN.md', 'prompt-ordinary-context-write');

      expect(refreshMemoryInstructionSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['retry', { 'qwen.daemon.retry': true }, false],
      ['continue', { 'qwen.daemon.continueLastTurn': true }, true],
    ])(
      'preserves context-file refresh intent across an ACP %s turn',
      async (_label, meta, seedInterruptedHistory) => {
        await markAcpContextRefreshIntent();
        refreshMemoryInstructionSpy.mockClear();
        if (seedInterruptedHistory) {
          vi.mocked(mockChat.getHistory).mockReturnValue([
            { role: 'user', parts: [{ text: 'unanswered question' }] },
          ]);
        }
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        agentTelemetry.addAgentInputMessageAttributes.mockClear();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'continue remembered fact write' }],
          _meta: meta,
        } as Parameters<typeof session.prompt>[0]);

        // Pin that the continuation turn reached the model: one send from the
        // marking turn and one from the continuation. Without this, a future
        // recovery-plan classifier change could make the turn return before
        // the intent-clearing gate while this test stays green.
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          agentTelemetry.addAgentInputMessageAttributes,
        ).not.toHaveBeenCalled();

        allowAcpWriteFile();
        await runAcpWriteFile(
          '/repo/QWEN.md',
          'prompt-preserved-context-write',
        );

        expect(refreshMemoryInstructionSpy).toHaveBeenCalledWith(mockConfig, {
          logContext:
            'ACP session test-session-id context-file memory tool batch',
        });
      },
    );

    it('does not refresh context-file instructions for ordinary ACP QWEN.md writes', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'wrote context',
        returnDisplay: 'wrote context',
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool(core.ToolNames.WRITE_FILE, execute),
      );

      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-ordinary-context-write',
        [
          {
            id: 'write_context',
            name: core.ToolNames.WRITE_FILE,
            args: { file_path: '/repo/QWEN.md' },
          },
        ],
      );

      expect(refreshMemoryAfterManagedWriteSpy).toHaveBeenCalledTimes(1);
      expect(refreshMemoryInstructionSpy).not.toHaveBeenCalled();
    });

    it('does not fire PostToolBatch hooks from the ACP session path', async () => {
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output: { decision: 'allow', eventName: request.eventName },
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation(
          (eventName: string) => eventName === 'PostToolBatch',
        );
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'tool output',
        returnDisplay: 'tool output',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockAllowedTool('read_file', execute),
      );

      await (session as unknown as ToolCallInternals).runToolCalls(
        new AbortController().signal,
        'prompt-batch-artifacts',
        [
          {
            id: 'read_call',
            name: 'read_file',
            args: { path: 'README.md' },
          },
        ],
      );

      expect(
        messageBus.request.mock.calls.some(
          ([request]) => request.eventName === 'PostToolBatch',
        ),
      ).toBe(false);
      expect(mockClient.extNotification).not.toHaveBeenCalledWith(
        'qwen/notify/session/artifact-event',
        expect.objectContaining({ hookEventName: 'PostToolBatch' }),
      );
    });

    it('marks cancelled ask_user_question as a turn stop', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, execute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-question-cancel', [
        {
          id: 'question_call',
          name: core.ToolNames.ASK_USER_QUESTION,
          args: { questions: [{ header: 'Continue?', question: 'Continue?' }] },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]?.functionResponse?.id).toBe('question_call');
      expect(result.parts[0]?.functionResponse?.response).toEqual({
        error: `Tool "${core.ToolNames.ASK_USER_QUESTION}" was canceled by the user.`,
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('skips later sequential tools after cancelled ask_user_question', async () => {
      const questionExecute = vi.fn();
      const shellExecute = vi.fn().mockResolvedValue({
        llmContent: 'shell result',
        returnDisplay: 'shell result',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.ASK_USER_QUESTION
          ? mockConfirmingTool(name, questionExecute)
          : mockAllowedTool(name, shellExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-question-shell', [
        {
          id: 'question_call',
          name: core.ToolNames.ASK_USER_QUESTION,
          args: { questions: [{ header: 'Continue?', question: 'Continue?' }] },
        },
        {
          id: 'shell_call',
          name: core.ToolNames.SHELL,
          args: { command: 'echo should-not-run' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(questionExecute).not.toHaveBeenCalled();
      expect(shellExecute).not.toHaveBeenCalled();
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'question_call',
        'shell_call',
      ]);
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[1]],
        expect.objectContaining({
          callId: 'shell_call',
          status: 'error',
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell_call',
          status: 'failed',
          _meta: expect.objectContaining({
            toolName: core.ToolNames.SHELL,
          }),
        }),
      });
      const shellUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            'toolCallId' in update &&
            update.toolCallId === 'shell_call' &&
            'status' in update,
        );
      expect(
        shellUpdates.map((update) => ({
          sessionUpdate: update.sessionUpdate,
          status: 'status' in update ? update.status : undefined,
        })),
      ).toEqual([
        { sessionUpdate: 'tool_call', status: 'pending' },
        { sessionUpdate: 'tool_call_update', status: 'failed' },
      ]);
    });

    it('preserves skipped tool responses when skipped tool updates fail', async () => {
      const questionExecute = vi.fn();
      const shellExecute = vi.fn().mockResolvedValue({
        llmContent: 'shell result',
        returnDisplay: 'shell result',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.ASK_USER_QUESTION
          ? mockConfirmingTool(name, questionExecute)
          : mockAllowedTool(name, shellExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });
      vi.mocked(mockClient.sessionUpdate).mockImplementation(
        async ({ update }) => {
          if (
            'toolCallId' in update &&
            update.toolCallId === 'shell_call' &&
            update.sessionUpdate === 'tool_call'
          ) {
            throw new Error('client disconnected');
          }
        },
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-question-shell-disconnect',
        [
          {
            id: 'question_call',
            name: core.ToolNames.ASK_USER_QUESTION,
            args: {
              questions: [{ header: 'Continue?', question: 'Continue?' }],
            },
          },
          {
            id: 'shell_call',
            name: core.ToolNames.SHELL,
            args: { command: 'echo should-not-run' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(shellExecute).not.toHaveBeenCalled();
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'question_call',
        'shell_call',
      ]);
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
    });

    it('uses stable unique ids for skipped tool calls without ids', async () => {
      const questionExecute = vi.fn();
      const shellExecute = vi.fn().mockResolvedValue({
        llmContent: 'shell result',
        returnDisplay: 'shell result',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.ASK_USER_QUESTION
          ? mockConfirmingTool(name, questionExecute)
          : mockAllowedTool(name, shellExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-skip-no-ids', [
        {
          id: 'question_call',
          name: core.ToolNames.ASK_USER_QUESTION,
          args: { questions: [{ header: 'Continue?', question: 'Continue?' }] },
        },
        {
          name: core.ToolNames.SHELL,
          args: { command: 'echo first' },
        },
        {
          name: core.ToolNames.SHELL,
          args: { command: 'echo second' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'question_call',
        `${core.ToolNames.SHELL}-skip-1`,
        `${core.ToolNames.SHELL}-skip-2`,
      ]);
    });

    it.each([false, true])(
      'denies outside Host reads before permissions, preserving user cancellation (agent-host=%s)',
      async (agentHost) => {
        vi.mocked(mockConfig.getSessionSourceType).mockReturnValue(
          agentHost ? 'agent-host' : undefined,
        );
        vi.mocked(
          mockConfig.getWorkspaceContext().isPathWithinWorkspace,
        ).mockImplementation((candidate) => candidate === process.cwd());
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
        const deniedExecute = vi.fn();
        const allowedExecute = vi.fn().mockResolvedValue({
          llmContent: 'ALLOWED_HOST_DIRECTORY',
          returnDisplay: 'ALLOWED_HOST_DIRECTORY',
        });
        const deniedTool = mockConfirmingTool(
          core.ToolNames.READ_FILE,
          deniedExecute,
          'info',
        );
        deniedTool.kind = core.Kind.Read;
        const deniedInvocation = deniedTool.build();
        deniedInvocation.params = { file_path: '/outside/denied.txt' };
        const allowedTool = mockAllowedTool(core.ToolNames.LS, allowedExecute);
        allowedTool.build().params = { path: process.cwd() };
        mockToolRegistry.getTool.mockImplementation((name: string) =>
          name === core.ToolNames.READ_FILE ? deniedTool : allowedTool,
        );
        const guard = vi.fn().mockResolvedValue({ allowed: true });
        mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);
        vi.mocked(mockClient.requestPermission).mockImplementation(
          async (p) => {
            const reject = p.options.find(
              (option: PermissionOption) => option.kind === 'reject_once',
            );
            expect(reject).toBeDefined();
            return {
              outcome: { outcome: 'selected', optionId: reject!.optionId },
            };
          },
        );

        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(new AbortController().signal, 'prompt-host-refusal', [
          {
            id: 'outside_read',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/outside/denied.txt' },
          },
          {
            id: 'inside_list',
            name: core.ToolNames.LS,
            args: { path: process.cwd() },
          },
        ]);

        expect(mockClient.requestPermission).toHaveBeenCalledTimes(
          agentHost ? 0 : 1,
        );
        expect(deniedExecute).not.toHaveBeenCalled();
        expect(result.stopAfterPermissionCancel).toBe(!agentHost);
        expect(allowedExecute).toHaveBeenCalledTimes(agentHost ? 1 : 0);
        expect(guard).toHaveBeenCalledTimes(agentHost ? 1 : 0);
        if (agentHost) {
          expect(deniedInvocation.getDefaultPermission).not.toHaveBeenCalled();
          expect(result.parts[0]?.functionResponse?.response).toEqual({
            error: 'Agent Host reads are limited to the assigned workspace.',
          });
          expect(guard).toHaveBeenCalledWith(
            expect.objectContaining({
              toolName: core.ToolNames.LS,
              permissionChecked: true,
            }),
          );
          expect(result.parts[1]?.functionResponse?.response).toEqual({
            output: 'ALLOWED_HOST_DIRECTORY',
          });
        }
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [result.parts[0]],
          expect.objectContaining({
            callId: 'outside_read',
            status: agentHost ? 'error' : 'cancelled',
            executionStatus: 'not_started',
            errorType: agentHost
              ? core.ToolErrorType.EXECUTION_DENIED
              : undefined,
          }),
        );
      },
    );

    it('records an approval-needing inside Host read as a policy denial, not a user cancel', async () => {
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('agent-host');
      const insidePath = path.join(process.cwd(), 'approval-needed.txt');
      vi.mocked(
        mockConfig.getWorkspaceContext().isPathWithinWorkspace,
      ).mockImplementation(
        (candidate) => candidate === insidePath || candidate === process.cwd(),
      );
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      const refusedExecute = vi.fn();
      const allowedExecute = vi.fn().mockResolvedValue({
        llmContent: 'ALLOWED_HOST_DIRECTORY',
        returnDisplay: 'ALLOWED_HOST_DIRECTORY',
      });
      const refusedTool = mockConfirmingTool(
        core.ToolNames.READ_FILE,
        refusedExecute,
        'info',
      );
      refusedTool.kind = core.Kind.Read;
      refusedTool.build().params = { file_path: insidePath };
      const allowedTool = mockAllowedTool(core.ToolNames.LS, allowedExecute);
      allowedTool.build().params = { path: process.cwd() };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.READ_FILE ? refusedTool : allowedTool,
      );
      const guard = vi.fn().mockResolvedValue({ allowed: true });
      mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);
      vi.mocked(mockClient.requestPermission).mockImplementation(async (p) => {
        const reject = p.options.find(
          (option: PermissionOption) => option.kind === 'reject_once',
        );
        expect(reject).toBeDefined();
        return {
          outcome: { outcome: 'selected', optionId: reject!.optionId },
        };
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-host-approval', [
        {
          id: 'inside_read',
          name: core.ToolNames.READ_FILE,
          args: { file_path: insidePath },
        },
        {
          id: 'inside_list',
          name: core.ToolNames.LS,
          args: { path: process.cwd() },
        },
      ]);

      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(refusedExecute).not.toHaveBeenCalled();
      // A Host auto-refusal is a policy denial: it must not stop the batch.
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(result.parts[0]?.functionResponse?.response).toEqual({
        error: `Tool "${core.ToolNames.READ_FILE}" requires approval, which is unavailable on this read-only Agent Host.`,
      });
      expect(allowedExecute).toHaveBeenCalledTimes(1);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[0]],
        expect.objectContaining({
          callId: 'inside_read',
          status: 'error',
          executionStatus: 'not_started',
          errorType: core.ToolErrorType.EXECUTION_DENIED,
        }),
      );
    });

    it('checks full Host authority once after permission-hook input rewriting', async () => {
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('agent-host');
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      const originalPath = path.join(process.cwd(), 'original.txt');
      const updatedPath = path.join(process.cwd(), 'updated.txt');
      const permissionHook = vi
        .spyOn(core, 'firePermissionRequestHook')
        .mockResolvedValue({
          hasDecision: true,
          shouldAllow: true,
          updatedInput: { file_path: updatedPath },
        });
      const preHook = vi
        .spyOn(core, 'firePreToolUseHook')
        .mockResolvedValue({ shouldProceed: true });
      const upstream = vi.fn().mockImplementation(async () => {
        expect(preHook).toHaveBeenCalledOnce();
        return { allowed: false, reason: 'upstream Host policy denied' };
      });
      mockConfig.getToolInvocationGuard = vi
        .fn()
        .mockReturnValue(
          createAgentHostToolInvocationGuard(
            upstream,
            process.cwd(),
            (candidate) =>
              mockConfig.getWorkspaceContext().isPathWithinWorkspace(candidate),
          ),
        );
      const execute = vi.fn();
      const tool = mockConfirmingTool(
        core.ToolNames.READ_FILE,
        execute,
        'info',
      );
      tool.kind = core.Kind.Read;
      // A replacement input is rebuilt, so each build carries its own params.
      const invocation = tool.build();
      tool.build.mockImplementation((params: Record<string, unknown>) => ({
        ...invocation,
        params,
      }));
      mockToolRegistry.getTool.mockReturnValue(tool);

      try {
        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(new AbortController().signal, 'prompt-host-upstream', [
          {
            id: 'inside_read',
            name: core.ToolNames.READ_FILE,
            args: { file_path: originalPath },
          },
        ]);

        expect(permissionHook).toHaveBeenCalledOnce();
        expect(upstream).toHaveBeenCalledOnce();
        expect(upstream).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: core.ToolNames.READ_FILE,
            args: { file_path: updatedPath },
            permissionChecked: true,
            sessionId: 'test-session-id',
            cwd: process.cwd(),
          }),
        );
        expect(mockClient.requestPermission).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(result.stopAfterPermissionCancel).toBe(false);
        expect(result.parts[0]?.functionResponse?.response).toEqual({
          error: 'upstream Host policy denied',
        });
      } finally {
        permissionHook.mockRestore();
        preHook.mockRestore();
      }
    });

    it('skips later tools after non-question permission cancellation', async () => {
      const cancelledExecute = vi.fn();
      const laterExecute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.SHELL
          ? mockConfirmingTool(name, cancelledExecute, 'exec')
          : mockAllowedTool(name, laterExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-shell-cancel', [
        {
          id: 'shell_call',
          name: core.ToolNames.SHELL,
          args: { command: 'echo denied' },
        },
        {
          id: 'read_call',
          name: core.ToolNames.READ_FILE,
          args: { file_path: '/tmp/should-not-run' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'shell_call',
        'read_call',
      ]);
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
      expect(cancelledExecute).not.toHaveBeenCalled();
      expect(laterExecute).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[0]],
        expect.objectContaining({
          callId: 'shell_call',
          status: 'cancelled',
          executionStatus: 'not_started',
          error: undefined,
          errorType: undefined,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[1]],
        expect.objectContaining({
          callId: 'read_call',
          executionStatus: 'not_started',
        }),
      );
    });

    it('skips later pre-loop tools after non-question permission cancellation', async () => {
      const cancelledExecute = vi.fn();
      const laterExecute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.SHELL
          ? mockConfirmingTool(name, cancelledExecute, 'exec')
          : mockAllowedTool(name, laterExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });
      const toolLoopState: DaemonToolLoopState = {
        totalToolCalls: 0,
        invalidToolParamErrors: new Map<string, number>(),
        toolCallKeyCounts: new Map<string, number>(),
        maxToolCallKeyRepeat: 0,
        loopDetected: false,
        repeatedToolFailureMode: 'off',
        repeatedToolFailureState: createRepeatedToolFailureGuardState(),
      };

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-pre-loop-shell-cancel',
        [
          {
            id: 'shell_call',
            name: core.ToolNames.SHELL,
            args: { command: 'echo denied' },
          },
          {
            id: 'read_1',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/tmp/one' },
          },
          {
            id: 'read_2',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/tmp/two' },
          },
          {
            id: 'read_3',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/tmp/three' },
          },
        ],
        toolLoopState,
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'shell_call',
        'read_1',
        'read_2',
        'read_3',
      ]);
      expect(
        result.parts.slice(1).map((part) => part.functionResponse?.response),
      ).toEqual([
        {
          error:
            'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
        },
        {
          error:
            'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
        },
        {
          error:
            'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
        },
      ]);
      expect(cancelledExecute).not.toHaveBeenCalled();
      expect(laterExecute).not.toHaveBeenCalled();
    });

    it('skips later tools after selecting the reject permission option', async () => {
      const rejectedExecute = vi.fn();
      const laterExecute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.SHELL
          ? mockConfirmingTool(name, rejectedExecute, 'exec')
          : mockAllowedTool(name, laterExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: {
          outcome: 'selected',
          optionId: core.ToolConfirmationOutcome.Cancel,
        },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-shell-reject', [
        {
          id: 'shell_call',
          name: core.ToolNames.SHELL,
          args: { command: 'echo denied' },
        },
        {
          id: 'read_call',
          name: core.ToolNames.READ_FILE,
          args: { file_path: '/tmp/should-not-run' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'shell_call',
        'read_call',
      ]);
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
      expect(rejectedExecute).not.toHaveBeenCalled();
      expect(laterExecute).not.toHaveBeenCalled();
    });

    it('skips later tools when cancellation confirmation cleanup fails', async () => {
      const rejectedExecute = vi.fn();
      const laterExecute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      const onConfirm = vi.fn().mockRejectedValue(new Error('cleanup failed'));
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.SHELL
          ? mockConfirmingTool(name, rejectedExecute, 'exec', onConfirm)
          : mockAllowedTool(name, laterExecute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-shell-cancel-cleanup-failed',
        [
          {
            id: 'shell_call',
            name: core.ToolNames.SHELL,
            args: { command: 'echo denied' },
          },
          {
            id: 'read_call',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/tmp/should-not-run' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(onConfirm).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        { answers: undefined },
      );
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'shell_call',
        'read_call',
      ]);
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
      expect(rejectedExecute).not.toHaveBeenCalled();
      expect(laterExecute).not.toHaveBeenCalled();
    });

    it('skips later tools after non-question permission request failure', async () => {
      const logToolCallSpy = vi
        .spyOn(core, 'logToolCall')
        .mockImplementation(() => {});
      const failedPermissionExecute = vi.fn();
      const laterExecute = vi.fn().mockResolvedValue({
        llmContent: 'should not execute',
        returnDisplay: 'should not execute',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.SHELL
          ? mockConfirmingTool(name, failedPermissionExecute, 'exec')
          : mockAllowedTool(name, laterExecute),
      );
      vi.mocked(mockClient.requestPermission).mockRejectedValueOnce(
        new Error('client disconnected'),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-shell-permission-failed',
        [
          {
            id: 'shell_call',
            name: core.ToolNames.SHELL,
            args: { command: 'echo denied' },
          },
          {
            id: 'read_call',
            name: core.ToolNames.READ_FILE,
            args: { file_path: '/tmp/should-not-run' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'shell_call',
        'read_call',
      ]);
      expect(result.parts[0]?.functionResponse?.response).toEqual({
        error: `Permission request failed for "${core.ToolNames.SHELL}": client disconnected`,
      });
      expect(result.parts[1]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
      expect(failedPermissionExecute).not.toHaveBeenCalled();
      expect(laterExecute).not.toHaveBeenCalled();
      expect(logToolCallSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          call_id: 'shell_call',
          status: 'error',
          execution_status: 'not_started',
          error_type: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[0]],
        expect.objectContaining({
          callId: 'shell_call',
          status: 'error',
          executionStatus: 'not_started',
          errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
        }),
      );
    });

    it.each([false, true])(
      'does not treat a parent abort during permission as explicit rejection (agent-host=%s)',
      async (agentHost) => {
        vi.mocked(mockConfig.getSessionSourceType).mockReturnValue(
          agentHost ? 'agent-host' : undefined,
        );
        const permissionExecute = vi.fn();
        const laterExecute = vi.fn().mockResolvedValue({
          llmContent: 'should not execute',
          returnDisplay: 'should not execute',
        });
        const permissionToolName = agentHost
          ? core.ToolNames.READ_FILE
          : core.ToolNames.SHELL;
        const permissionArgs = agentHost
          ? { file_path: path.join(process.cwd(), 'approval-needed.txt') }
          : { command: 'echo denied' };
        const permissionTool = mockConfirmingTool(
          permissionToolName,
          permissionExecute,
          agentHost ? 'info' : 'exec',
        );
        if (agentHost) permissionTool.kind = core.Kind.Read;
        permissionTool.build().params = permissionArgs;
        mockToolRegistry.getTool.mockImplementation((name: string) =>
          name === permissionToolName
            ? permissionTool
            : mockAllowedTool(name, laterExecute),
        );
        vi.mocked(mockClient.requestPermission).mockReturnValueOnce(
          new Promise<never>(() => {
            // requestPermissionWithAbort owns cancellation of this pending call.
          }),
        );
        const abortController = new AbortController();

        const runPromise = (
          session as unknown as ToolCallInternals
        ).runToolCalls(
          abortController.signal,
          'prompt-shell-permission-parent-abort',
          [
            {
              id: 'shell_call',
              name: permissionToolName,
              args: permissionArgs,
            },
            {
              id: 'read_call',
              name: agentHost ? core.ToolNames.LS : core.ToolNames.READ_FILE,
              args: agentHost
                ? { path: process.cwd() }
                : { file_path: '/tmp/should-not-run' },
            },
          ],
        );

        await vi.waitFor(() =>
          expect(mockClient.requestPermission).toHaveBeenCalledOnce(),
        );
        abortController.abort();
        const result = await runPromise;

        expect(result.stopAfterPermissionCancel).toBe(false);
        expect(
          result.parts.map((part) => part.functionResponse?.response),
        ).toEqual([
          { error: 'Tool call was cancelled before execution.' },
          { error: 'Tool call was cancelled before execution.' },
        ]);
        expect(permissionExecute).not.toHaveBeenCalled();
        expect(laterExecute).not.toHaveBeenCalled();
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [result.parts[0]],
          expect.objectContaining({
            callId: 'shell_call',
            status: 'cancelled',
            executionStatus: 'not_started',
          }),
        );
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [result.parts[1]],
          expect.objectContaining({
            callId: 'read_call',
            status: 'cancelled',
            executionStatus: 'not_started',
          }),
        );
      },
    );

    it('keeps plan mode and gives manual guidance when switch_mode approval is unavailable', async () => {
      const execute = vi.fn();
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.EXIT_PLAN_MODE,
        kind: core.Kind.Think,
        build: vi.fn().mockReturnValue({
          params: { plan: 'Plan' },
          requiresUserInteraction: vi.fn().mockReturnValue(true),
          getDefaultPermission: vi.fn().mockResolvedValue('ask'),
          getConfirmationDetails: vi.fn().mockResolvedValue({
            type: 'plan',
            title: 'Approve plan',
            plan: 'Plan',
            onConfirm,
          }),
          getDescription: vi.fn().mockReturnValue('Plan:'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute,
        }),
      });
      vi.mocked(mockClient.requestPermission).mockRejectedValueOnce(
        new Error('switch_mode unsupported'),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-plan-failed', [
        {
          id: 'exit_plan_call',
          name: core.ToolNames.EXIT_PLAN_MODE,
          args: { plan: 'Plan' },
        },
      ]);

      expect(result.parts[0]?.functionResponse?.response).toEqual({
        error: expect.stringMatching(/mode selector.*\/plan exit/),
      });
      expect(onConfirm).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) => params.update.sessionUpdate === 'current_mode_update',
          ),
      ).toBe(false);
    });

    it('cleans up Agent sub-agent listeners when permission request fails before execution', async () => {
      const eventEmitter = new EventEmitter();
      const execute = vi.fn();
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('ask'),
          getConfirmationDetails: vi.fn().mockResolvedValue({
            type: 'info',
            title: 'Agent permission',
            prompt: 'Allow agent?',
            onConfirm,
          }),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockRejectedValueOnce(
        new Error('client disconnected'),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-agent-permission-failed',
        [
          {
            id: 'agent_call',
            name: core.ToolNames.AGENT,
            args: { subagent_type: 'explore' },
          },
        ],
      );

      eventEmitter.emit(core.AgentEventType.TOOL_RESULT, {
        subagentId: 'subagent-1',
        round: 1,
        callId: 'late_tool',
        name: core.ToolNames.SHELL,
        success: true,
        responseParts: [{ text: 'late result' }],
        resultDisplay: 'late result',
        timestamp: Date.now(),
      });
      await Promise.resolve();

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(onConfirm).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
      );
      const subagentUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'tool_call_update' &&
            update._meta?.provenance === 'subagent',
        );
      expect(subagentUpdates).toEqual([]);
    });

    it('stops and aborts Agent tool execution after nested ask_user_question cancellation', async () => {
      const eventEmitter = new EventEmitter();
      let executeSignal: AbortSignal | undefined;
      const respond = vi.fn().mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          executeSignal = signal;
          emitNestedAskUserQuestion(eventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-question', [
        {
          id: 'agent_call',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(executeSignal?.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        {
          answers: undefined,
        },
      );
      expect(result.parts[0]?.functionResponse?.id).toBe('agent_call');
    });

    it('stops and aborts Agent tool execution after nested non-question permission cancellation', async () => {
      const eventEmitter = new EventEmitter();
      let executeSignal: AbortSignal | undefined;
      const respond = vi.fn().mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          executeSignal = signal;
          emitNestedInfoPermission(eventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-agent-nested-shell-cancel',
        [
          {
            id: 'agent_call',
            name: core.ToolNames.AGENT,
            args: { subagent_type: 'explore' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(executeSignal?.aborted).toBe(true);
      expect(respond).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        {
          answers: undefined,
        },
      );
      expect(result.parts[0]?.functionResponse?.id).toBe('agent_call');
    });

    it('ignores later subagent tool events after nested ask_user_question cancellation', async () => {
      const eventEmitter = new EventEmitter();
      const respond = vi.fn().mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(eventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          eventEmitter.emit(core.AgentEventType.TOOL_RESULT, {
            subagentId: 'subagent-1',
            round: 1,
            callId: 'late_tool',
            name: core.ToolNames.SHELL,
            success: true,
            responseParts: [{ text: 'late result' }],
            resultDisplay: 'late result',
            timestamp: Date.now(),
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-late-event', [
        {
          id: 'agent_call',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
      ]);

      await Promise.resolve();

      expect(result.stopAfterPermissionCancel).toBe(true);
      const subagentUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'tool_call_update' &&
            update._meta?.provenance === 'subagent',
        );
      // Filter out the new subagentProgress frames, as they are intentionally
      // emitted before the cancellation check to keep the parent card live.
      // The new contract allows the pre cancellation approval progress update.

      const progressUpdates = subagentUpdates.filter(
        (update: { _meta?: { subagentProgress?: boolean } }) =>
          update?._meta?.subagentProgress,
      );
      expect(progressUpdates).toHaveLength(1);
      expect(progressUpdates[0].content?.[0]?.content?.text).toContain(
        'Waiting for permission',
      );

      const nonProgressUpdates = subagentUpdates.filter(
        (update: { _meta?: { subagentProgress?: boolean } }) =>
          !update?._meta?.subagentProgress,
      );
      expect(nonProgressUpdates).toEqual([]);
    });

    it('aborts sibling Agent calls in the same batch after nested ask_user_question cancellation', async () => {
      const questionEventEmitter = new EventEmitter();
      const siblingEventEmitter = new EventEmitter();
      let siblingSignal: AbortSignal | undefined;
      const respond = vi.fn().mockResolvedValue(undefined);
      const questionExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(questionEventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      const siblingExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          siblingSignal = signal;
          await waitForAbortOrTick(signal);
          return {
            llmContent: 'sibling stopped',
            returnDisplay: 'sibling stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
          const isQuestionAgent = args['_test_id'] === 'question';
          return {
            params: { subagent_type: 'explore', ...args },
            eventEmitter: isQuestionAgent
              ? questionEventEmitter
              : siblingEventEmitter,
            execute: isQuestionAgent ? questionExecute : siblingExecute,
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Agent'),
            toolLocations: vi.fn().mockReturnValue([]),
          };
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-siblings', [
        {
          id: 'agent_question',
          name: core.ToolNames.AGENT,
          args: { _test_id: 'question', subagent_type: 'explore' },
        },
        {
          id: 'agent_sibling',
          name: core.ToolNames.AGENT,
          args: { _test_id: 'sibling', subagent_type: 'explore' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(questionExecute).toHaveBeenCalledOnce();
      expect(siblingExecute).toHaveBeenCalledOnce();
      expect(siblingSignal?.aborted).toBe(true);
    });

    it('lets sibling Agent calls in a small batch finish when loop detection fires', async () => {
      const previousMaxConcurrency =
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      try {
        let firstSiblingSignal: AbortSignal | undefined;
        let secondSiblingSignal: AbortSignal | undefined;
        const firstSiblingExecute = vi
          .fn()
          .mockImplementation(async (signal: AbortSignal) => {
            firstSiblingSignal = signal;
            await waitForAbortOrTick(signal);
            return {
              llmContent: 'first sibling stopped',
              returnDisplay: 'first sibling stopped',
            };
          });
        const secondSiblingExecute = vi
          .fn()
          .mockImplementation(async (signal: AbortSignal) => {
            secondSiblingSignal = signal;
            await waitForAbortOrTick(signal);
            return {
              llmContent: 'second sibling stopped',
              returnDisplay: 'second sibling stopped',
            };
          });
        mockToolRegistry.getTool.mockReturnValue({
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            if (args['_test_id'] === 'invalid') {
              throw new Error('Invalid subagent_type: bad');
            }
            const isFirstSibling = args['_test_id'] === 'sibling_1';
            return {
              params: { subagent_type: 'explore', ...args },
              eventEmitter: new EventEmitter(),
              execute: isFirstSibling
                ? firstSiblingExecute
                : secondSiblingExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            };
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        const toolLoopState: DaemonToolLoopState = {
          totalToolCalls: 0,
          invalidToolParamErrors: new Map([[core.ToolNames.AGENT, 2]]),
          toolCallKeyCounts: new Map<string, number>(),
          maxToolCallKeyRepeat: 0,
          loopDetected: false,
          repeatedToolFailureMode: 'off',
          repeatedToolFailureState: createRepeatedToolFailureGuardState(),
        };

        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(
          new AbortController().signal,
          'prompt-agent-loop-abort',
          [
            {
              id: 'agent_invalid',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'invalid', subagent_type: 'bad' },
            },
            {
              id: 'agent_sibling_1',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'sibling_1', subagent_type: 'explore' },
            },
            {
              id: 'agent_sibling_2',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'sibling_2', subagent_type: 'explore' },
            },
          ],
          toolLoopState,
        );

        expect(result.loopDetected).toBe(true);
        expect(firstSiblingExecute).toHaveBeenCalledOnce();
        expect(secondSiblingExecute).toHaveBeenCalledOnce();
        // Agent-only batches run at full width (no serial prefix), so a batch
        // this size never hits the capped race branch: the loop fired by the
        // invalid call stops the turn without aborting mid-flight siblings —
        // they finish and their results are kept instead of being killed.
        expect(firstSiblingSignal?.aborted).toBe(false);
        expect(secondSiblingSignal?.aborted).toBe(false);
        expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
          'agent_invalid',
          'agent_sibling_1',
          'agent_sibling_2',
        ]);
      } finally {
        if (previousMaxConcurrency === undefined) {
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        } else {
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
            previousMaxConcurrency;
        }
      }
    });

    it('lets in-flight Agent calls of a wide batch finish when loop detection fires', async () => {
      const previousMaxConcurrency =
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = '2';
      try {
        let inFlightSignal: AbortSignal | undefined;
        const inFlightExecute = vi
          .fn()
          .mockImplementation(async (signal: AbortSignal) => {
            inFlightSignal = signal;
            await waitForAbortOrTick(signal);
            return {
              llmContent: 'in-flight sibling finished',
              returnDisplay: 'in-flight sibling finished',
            };
          });
        mockToolRegistry.getTool.mockReturnValue({
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            if (args['_test_id'] === 'invalid') {
              throw new Error('Invalid subagent_type: bad');
            }
            return {
              params: { subagent_type: 'explore', ...args },
              eventEmitter: new EventEmitter(),
              execute: inFlightExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            };
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        const toolLoopState: DaemonToolLoopState = {
          totalToolCalls: 0,
          // Two prior invalid-param errors: the first failure in this batch
          // trips the threshold of three while the sibling shares the
          // concurrency window, forcing the capped race branch.
          invalidToolParamErrors: new Map([[core.ToolNames.AGENT, 2]]),
          toolCallKeyCounts: new Map<string, number>(),
          maxToolCallKeyRepeat: 0,
          loopDetected: false,
          repeatedToolFailureMode: 'off',
          repeatedToolFailureState: createRepeatedToolFailureGuardState(),
        };

        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(
          new AbortController().signal,
          'prompt-agent-wide-loop-keep-results',
          [
            {
              id: 'agent_invalid',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'invalid', subagent_type: 'bad' },
            },
            {
              id: 'agent_in_flight',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'in_flight', subagent_type: 'explore' },
            },
            {
              id: 'agent_tail_1',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'tail_1', subagent_type: 'explore' },
            },
            {
              id: 'agent_tail_2',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'tail_2', subagent_type: 'explore' },
            },
          ],
          toolLoopState,
        );

        expect(result.loopDetected).toBe(true);
        expect(inFlightExecute).toHaveBeenCalledOnce();
        // The race branch for batches at/over the cap must behave like the
        // narrow-batch path above: the in-flight sibling is not aborted —
        // it settles and its result is kept — while the unstarted tail is
        // skipped.
        expect(inFlightSignal?.aborted).toBe(false);
        expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
          'agent_invalid',
          'agent_in_flight',
          'agent_tail_1',
          'agent_tail_2',
        ]);
        expect(
          result.parts[1].functionResponse?.response?.['error'],
        ).toBeUndefined();
        expect(
          result.parts
            .slice(2)
            .map((part) => part.functionResponse?.response?.['error']),
        ).toEqual([
          'Skipped because loop detection stopped the current turn before this tool call could run.',
          'Skipped because loop detection stopped the current turn before this tool call could run.',
        ]);
      } finally {
        if (previousMaxConcurrency === undefined) {
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        } else {
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
            previousMaxConcurrency;
        }
      }
    });

    it('does not treat parent abort during nested Agent permission as explicit rejection', async () => {
      const previousMaxConcurrency =
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = '1';
      try {
        const eventEmitter = new EventEmitter();
        const respond = vi.fn().mockResolvedValue(undefined);
        const firstExecute = vi
          .fn()
          .mockImplementation(async (signal: AbortSignal) => {
            emitNestedInfoPermission(eventEmitter, respond);
            await vi.waitFor(() => {
              expect(signal.aborted).toBe(true);
            });
            return {
              llmContent: 'agent stopped',
              returnDisplay: 'agent stopped',
            };
          });
        const secondExecute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue({
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi
            .fn()
            .mockImplementation((args: Record<string, unknown>) => ({
              params: { subagent_type: 'explore', ...args },
              eventEmitter,
              execute:
                args['_test_id'] === 'first' ? firstExecute : secondExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            })),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        vi.mocked(mockClient.requestPermission).mockReturnValueOnce(
          new Promise<never>(() => {}),
        );
        const abortController = new AbortController();

        const runPromise = (
          session as unknown as ToolCallInternals
        ).runToolCalls(
          abortController.signal,
          'prompt-agent-nested-permission-parent-abort',
          [
            {
              id: 'agent_first',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'first', subagent_type: 'explore' },
            },
            {
              id: 'agent_second',
              name: core.ToolNames.AGENT,
              args: { _test_id: 'second', subagent_type: 'explore' },
            },
          ],
        );

        await vi.waitFor(() => {
          expect(mockClient.requestPermission).toHaveBeenCalledOnce();
        });
        abortController.abort();
        const result = await runPromise;

        expect(result.stopAfterPermissionCancel).toBe(false);
        expect(firstExecute).toHaveBeenCalledOnce();
        expect(secondExecute).not.toHaveBeenCalled();
        expect(
          result.parts.map((part) => part.functionResponse?.response),
        ).toEqual([
          {
            error: 'The tool had already completed; its output was discarded.',
          },
          { error: 'Tool call was cancelled before execution.' },
        ]);
        await vi.waitFor(() => {
          expect(respond).toHaveBeenCalledWith(
            core.ToolConfirmationOutcome.Cancel,
          );
        });
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [result.parts[0]],
          expect.objectContaining({
            callId: 'agent_first',
            status: 'cancelled',
            executionStatus: 'cancelled',
          }),
        );
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [result.parts[1]],
          expect.objectContaining({
            callId: 'agent_second',
            status: 'cancelled',
            executionStatus: 'not_started',
          }),
        );
      } finally {
        if (previousMaxConcurrency === undefined) {
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        } else {
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
            previousMaxConcurrency;
        }
      }
    });

    it('does not start Agent batches with an already-aborted parent signal', async () => {
      const eventEmitter = new EventEmitter();
      const receivedAbortStates: boolean[] = [];
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          receivedAbortStates.push(signal.aborted);
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      const parentAbort = new AbortController();
      parentAbort.abort('parent cancelled');

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(parentAbort.signal, 'prompt-agent-pre-aborted', [
        {
          id: 'agent_first',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
        {
          id: 'agent_second',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(receivedAbortStates).toEqual([]);
      expect(
        result.parts.map((part) => part.functionResponse?.response),
      ).toEqual([
        { error: 'Tool call was cancelled before execution.' },
        { error: 'Tool call was cancelled before execution.' },
      ]);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[0]],
        expect.objectContaining({
          callId: 'agent_first',
          status: 'cancelled',
          executionStatus: 'not_started',
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [result.parts[1]],
        expect.objectContaining({
          callId: 'agent_second',
          status: 'cancelled',
          executionStatus: 'not_started',
        }),
      );
    });

    it('skips unstarted Agent calls after nested ask_user_question cancellation', async () => {
      const previousMaxConcurrency =
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
      process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = '1';
      try {
        const eventEmitter = new EventEmitter();
        const respond = vi.fn().mockResolvedValue(undefined);
        const questionExecute = vi
          .fn()
          .mockImplementation(async (signal: AbortSignal) => {
            emitNestedAskUserQuestion(eventEmitter, respond);
            await vi.waitFor(() => {
              expect(signal.aborted).toBe(true);
            });
            return {
              llmContent: 'agent stopped',
              returnDisplay: 'agent stopped',
            };
          });
        const secondExecute = vi.fn();
        const thirdExecute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue({
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const id = args['_test_id'];
            return {
              params: { subagent_type: 'explore', ...args },
              eventEmitter,
              execute:
                id === 'question'
                  ? questionExecute
                  : id === 'second'
                    ? secondExecute
                    : thirdExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            };
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
        });

        const result = await (
          session as unknown as ToolCallInternals
        ).runToolCalls(new AbortController().signal, 'prompt-agent-unstarted', [
          {
            id: 'agent_question',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'question', subagent_type: 'explore' },
          },
          {
            id: 'agent_second',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'second', subagent_type: 'explore' },
          },
          {
            id: 'agent_third',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'third', subagent_type: 'explore' },
          },
        ]);

        expect(result.stopAfterPermissionCancel).toBe(true);
        expect(questionExecute).toHaveBeenCalledOnce();
        expect(secondExecute).not.toHaveBeenCalled();
        expect(thirdExecute).not.toHaveBeenCalled();
        expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
          'agent_question',
          'agent_second',
          'agent_third',
        ]);
        expect(result.parts[1]?.functionResponse?.response).toEqual({
          error:
            'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
        });
        expect(result.parts[2]?.functionResponse?.response).toEqual({
          error:
            'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
        });
      } finally {
        if (previousMaxConcurrency === undefined) {
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        } else {
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
            previousMaxConcurrency;
        }
      }
    });

    it('skips later sequential batches after nested ask_user_question cancellation', async () => {
      const questionEventEmitter = new EventEmitter();
      const siblingEventEmitter = new EventEmitter();
      const respond = vi.fn().mockResolvedValue(undefined);
      const questionExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(questionEventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      const siblingExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          await waitForAbortOrTick(signal);
          return {
            llmContent: 'sibling stopped',
            returnDisplay: 'sibling stopped',
          };
        });
      const shellExecute = vi.fn().mockResolvedValue({
        llmContent: 'shell result',
        returnDisplay: 'shell result',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) => {
        if (name !== core.ToolNames.AGENT) {
          return mockAllowedTool(name, shellExecute);
        }
        return {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const isQuestionAgent = args['_test_id'] === 'question';
            return {
              params: { subagent_type: 'explore', ...args },
              eventEmitter: isQuestionAgent
                ? questionEventEmitter
                : siblingEventEmitter,
              execute: isQuestionAgent ? questionExecute : siblingExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            };
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        };
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-then-shell', [
        {
          id: 'agent_question',
          name: core.ToolNames.AGENT,
          args: { _test_id: 'question', subagent_type: 'explore' },
        },
        {
          id: 'agent_sibling',
          name: core.ToolNames.AGENT,
          args: { _test_id: 'sibling', subagent_type: 'explore' },
        },
        {
          id: 'shell_after',
          name: core.ToolNames.SHELL,
          args: { command: 'echo should-not-run' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(questionExecute).toHaveBeenCalledOnce();
      expect(siblingExecute).toHaveBeenCalledOnce();
      expect(shellExecute).not.toHaveBeenCalled();
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'agent_question',
        'agent_sibling',
        'shell_after',
      ]);
      expect(result.parts[2]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
    });

    it('skips later sequential batches after nested non-question permission cancellation', async () => {
      const permissionEventEmitter = new EventEmitter();
      const siblingEventEmitter = new EventEmitter();
      let siblingSignal: AbortSignal | undefined;
      const respond = vi.fn().mockResolvedValue(undefined);
      const permissionExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedInfoPermission(permissionEventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      const siblingExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          siblingSignal = signal;
          await waitForAbortOrTick(signal);
          return {
            llmContent: 'sibling stopped',
            returnDisplay: 'sibling stopped',
          };
        });
      const shellExecute = vi.fn().mockResolvedValue({
        llmContent: 'shell result',
        returnDisplay: 'shell result',
      });
      mockToolRegistry.getTool.mockImplementation((name: string) => {
        if (name !== core.ToolNames.AGENT) {
          return mockAllowedTool(name, shellExecute);
        }
        return {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          displayName: 'Agent',
          description: 'Agent',
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const isPermissionAgent = args['_test_id'] === 'permission';
            return {
              params: { subagent_type: 'explore', ...args },
              eventEmitter: isPermissionAgent
                ? permissionEventEmitter
                : siblingEventEmitter,
              execute: isPermissionAgent ? permissionExecute : siblingExecute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Agent'),
              toolLocations: vi.fn().mockReturnValue([]),
            };
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        };
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-agent-shell-cancel',
        [
          {
            id: 'agent_permission',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'permission', subagent_type: 'explore' },
          },
          {
            id: 'agent_sibling',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'sibling', subagent_type: 'explore' },
          },
          {
            id: 'shell_after',
            name: core.ToolNames.SHELL,
            args: { command: 'echo should-not-run' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(permissionExecute).toHaveBeenCalledOnce();
      expect(siblingExecute).toHaveBeenCalledOnce();
      expect(siblingSignal?.aborted).toBe(true);
      expect(shellExecute).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        {
          answers: undefined,
        },
      );
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'agent_permission',
        'agent_sibling',
        'shell_after',
      ]);
      expect(result.parts[2]?.functionResponse?.response).toEqual({
        error:
          'Skipped because a permission request was cancelled before the user answered; user input is required before continuing.',
      });
    });

    it('does not fire success hooks for sibling Agents aborted by nested ask_user_question cancellation', async () => {
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: {},
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      const questionEventEmitter = new EventEmitter();
      const siblingEventEmitter = new EventEmitter();
      const respond = vi.fn().mockResolvedValue(undefined);
      const questionExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(questionEventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
          };
        });
      const siblingExecute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          await waitForAbortOrTick(signal);
          return {
            llmContent: 'sibling stopped',
            returnDisplay: 'sibling stopped',
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
          const isQuestionAgent = args['_test_id'] === 'question';
          return {
            params: { subagent_type: 'explore', ...args },
            eventEmitter: isQuestionAgent
              ? questionEventEmitter
              : siblingEventEmitter,
            execute: isQuestionAgent ? questionExecute : siblingExecute,
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Agent'),
            toolLocations: vi.fn().mockReturnValue([]),
          };
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-agent-sibling-hooks',
        [
          {
            id: 'agent_question',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'question', subagent_type: 'explore' },
          },
          {
            id: 'agent_sibling',
            name: core.ToolNames.AGENT,
            args: { _test_id: 'sibling', subagent_type: 'explore' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      const hookRequests = messageBus.request.mock.calls.map(([request]) => {
        const eventName =
          typeof request === 'object' &&
          request !== null &&
          'eventName' in request
            ? request.eventName
            : undefined;
        const input =
          typeof request === 'object' && request !== null && 'input' in request
            ? request.input
            : undefined;
        return { eventName, input };
      });
      expect(
        hookRequests.filter(({ eventName }) => eventName === 'PostToolUse'),
      ).toEqual([]);
      expect(hookRequests).toContainEqual(
        expect.objectContaining({
          eventName: 'PostToolUseFailure',
          input: expect.objectContaining({
            is_interrupt: true,
          }),
        }),
      );
    });

    it('marks Agent exceptions after nested ask_user_question cancellation as interrupts', async () => {
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: {},
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      const eventEmitter = new EventEmitter();
      const respond = vi.fn().mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(eventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          throw new Error('agent aborted after question cancel');
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-agent-interrupt', [
        {
          id: 'agent_call',
          name: core.ToolNames.AGENT,
          args: { subagent_type: 'explore' },
        },
      ]);

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'PostToolUseFailure',
          input: expect.objectContaining({
            is_interrupt: true,
          }),
          signal: expect.objectContaining({
            aborted: true,
          }),
        }),
        expect.anything(),
      );
    });

    it('marks Agent soft errors after nested ask_user_question cancellation as interrupts', async () => {
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: {},
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      const eventEmitter = new EventEmitter();
      const respond = vi.fn().mockResolvedValue(undefined);
      const execute = vi
        .fn()
        .mockImplementation(async (signal: AbortSignal) => {
          emitNestedAskUserQuestion(eventEmitter, respond);
          await vi.waitFor(() => {
            expect(signal.aborted).toBe(true);
          });
          return {
            llmContent: 'agent stopped',
            returnDisplay: 'agent stopped',
            error: { message: 'agent aborted after question cancel' },
          };
        });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.AGENT,
        kind: core.Kind.Think,
        displayName: 'Agent',
        description: 'Agent',
        build: vi.fn().mockReturnValue({
          params: { subagent_type: 'explore' },
          eventEmitter,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: { outcome: 'cancelled' },
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-agent-soft-interrupt',
        [
          {
            id: 'agent_call',
            name: core.ToolNames.AGENT,
            args: { subagent_type: 'explore' },
          },
        ],
      );

      expect(result.stopAfterPermissionCancel).toBe(true);
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'PostToolUseFailure',
          input: expect.objectContaining({
            is_interrupt: true,
          }),
          signal: expect.objectContaining({
            aborted: true,
          }),
        }),
        expect.anything(),
      );
    });

    it('executes only the first duplicate functionCall id in one batch', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'first result',
        returnDisplay: 'first result',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { file_path: 'a.ts' },
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-dup', [
        {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'a.ts' },
        },
        {
          id: 'dup_id_0001',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      ]);

      expect(execute).toHaveBeenCalledOnce();
      expect(result.parts.map((part) => part.functionResponse?.id)).toEqual([
        'dup_id_0001',
      ]);
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledOnce();
    });

    it('finalizes the aggregate ACP response before recording and returning it', async () => {
      const prefix = 'Tool output was too large and has been truncated';
      const execute = vi.fn().mockImplementation(async () => ({
        llmContent: `${prefix}${'x'.repeat(7000)}`,
        returnDisplay: 'full display',
        persistedOutputFiles: [],
      }));
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { file_path: 'a.ts' },
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      mockConfig.getToolOutputBatchBudget = vi.fn().mockReturnValue(10_000);
      mockChatRecordingService.recordToolResult.mockClear();

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-budget', [
        { name: 'read_file', args: { file_path: 'a.ts' } },
        { name: 'read_file', args: { file_path: 'b.ts' } },
      ]);

      const textLength = (parts: Part[]) =>
        parts.reduce((sum, part) => {
          const output = part.functionResponse?.response?.['output'];
          return sum + (typeof output === 'string' ? output.length : 0);
        }, 0);
      expect(textLength(result.parts)).toBeLessThanOrEqual(10_000);
      const recordedParts =
        mockChatRecordingService.recordToolResult.mock.calls.flatMap(
          (call) => call[0] as Part[],
        );
      expect(textLength(recordedParts)).toBe(textLength(result.parts));
      expect(recordedParts).toEqual(result.parts);
      const responseIds = result.parts.map((part) => part.functionResponse?.id);
      expect(new Set(responseIds).size).toBe(2);
      expect(responseIds[0]).toMatch(/-0$/);
      expect(responseIds[1]).toMatch(/-1$/);
    });

    it('suppresses duplicate provider functionCall ids already answered in history', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'should not run',
        returnDisplay: 'should not run',
      });
      const build = vi.fn().mockReturnValue({
        params: { file_path: 'b.ts' },
        execute,
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getDescription: vi.fn().mockReturnValue('Read file'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([
          [
            'shell_1',
            core.getToolCallFingerprint('read_file', { file_path: 'b.ts' }),
          ],
        ]),
      );
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'shell_1',
              name: 'read_file',
              args: { file_path: 'b.ts' },
            },
          },
        ],
        new Set(['shell_1']),
        new Set<string>(),
      );
      const duplicateCall = duplicatePart.functionCall!;

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-history-dup', [
        duplicateCall,
      ]);

      expect(mockToolRegistry.getTool).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      const { parts } = result;
      expect(parts).toHaveLength(1);
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(result.repeatedToolFailureBatch).toEqual({
        complete: true,
        observations: [
          expect.objectContaining({
            callId: 'shell_1__qwen_dup_2',
            providerDuplicate: true,
            executionStatus: 'not_started',
          }),
        ],
      });
      expect(parts[0].functionResponse?.id).toBe('shell_1__qwen_dup_2');
      expect(parts[0].functionResponse?.response).toEqual({
        error: expect.stringContaining(
          'Duplicate provider tool call id "shell_1"',
        ),
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        parts,
        expect.objectContaining({
          callId: 'shell_1__qwen_dup_2',
          status: 'error',
          resultDisplay: expect.stringContaining(
            'Duplicate provider tool call id "shell_1"',
          ),
          error: expect.any(Error),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'shell_1__qwen_dup_2',
            status: 'failed',
          }),
        }),
      );
      expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'shell_1__qwen_dup_2',
          }),
        }),
      );
    });

    it('records a duplicated bridged Goal read as Goal bookkeeping', async () => {
      const permit: core.GoalTurnPermit = {
        goalId: 'goal-duplicate',
        revision: 1,
        turnId: 'turn-duplicate',
      };
      const args = { name: 'get_goal', arguments: {} };
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([['goal_1', core.getToolCallFingerprint('tool_call', args)]]),
      );
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'goal_1',
              name: 'tool_call',
              args,
            },
          },
        ],
        new Set(['goal_1']),
        new Set<string>(),
      );

      await core.goalTurnContext.run(permit, () =>
        (session as unknown as ToolCallInternals).runToolCalls(
          new AbortController().signal,
          'prompt-goal-duplicate',
          [duplicatePart.functionCall!],
        ),
      );

      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledOnce();
      expect(
        mockChatRecordingService.recordToolResult.mock.calls[0]?.[2],
      ).toEqual({ goalContext: permit, provenance: 'goal_runtime' });
    });

    it('executes an id-colliding functionCall whose args differ from the handled call', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'fresh result',
        returnDisplay: 'fresh result',
      });
      const build = vi.fn().mockReturnValue({
        params: { file_path: 'c.ts' },
        execute,
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getDescription: vi.fn().mockReturnValue('Read file'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([
          [
            'shell_1',
            core.getToolCallFingerprint('read_file', { file_path: 'b.ts' }),
          ],
        ]),
      );
      const [collidingPart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'shell_1',
              name: 'read_file',
              args: { file_path: 'c.ts' },
            },
          },
        ],
        new Set(['shell_1']),
        new Set<string>(),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-id-collision', [
        collidingPart.functionCall!,
      ]);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.loopDetected).toBeUndefined();
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].functionResponse?.id).toBe('shell_1__qwen_dup_2');
      expect(result.parts[0].functionResponse?.response).toEqual({
        output: 'fresh result',
      });
    });

    it('records repeated duplicate provider calls without returning results', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'should not run',
        returnDisplay: 'should not run',
      });
      const build = vi.fn().mockReturnValue({
        params: { file_path: 'b.ts' },
        execute,
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getDescription: vi.fn().mockReturnValue('Read file'),
        toolLocations: vi.fn().mockReturnValue([]),
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build,
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([
          [
            'shell_1',
            core.getToolCallFingerprint('read_file', { file_path: 'b.ts' }),
          ],
        ]),
      );
      const usedIds = new Set(['shell_1']);
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'shell_1',
              name: 'read_file',
              args: { file_path: 'b.ts' },
            },
          },
        ],
        usedIds,
        new Set<string>(),
      );
      const duplicateCall = duplicatePart.functionCall!;

      const firstResult = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-history-dup', [
        duplicateCall,
      ]);
      const [repeatedPart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'shell_1',
              name: 'read_file',
              args: { file_path: 'b.ts' },
            },
          },
        ],
        usedIds,
        new Set<string>(),
      );
      const toolLoopState: DaemonToolLoopState = {
        totalToolCalls: 0,
        invalidToolParamErrors: new Map<string, number>(),
        toolCallKeyCounts: new Map<string, number>(),
        maxToolCallKeyRepeat: 0,
        loopDetected: false,
        repeatedToolFailureMode: 'off',
        repeatedToolFailureState: createRepeatedToolFailureGuardState(),
      };
      expect(repeatedPart.functionCall?.id).toBe('shell_1__qwen_dup_3');
      const secondResult = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(
        new AbortController().signal,
        'prompt-history-dup',
        [
          repeatedPart.functionCall!,
          { id: 'fresh_shell', name: 'read_file', args: { file_path: 'c.ts' } },
        ],
        toolLoopState,
      );

      expect(mockToolRegistry.getTool).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(firstResult.parts).toHaveLength(1);
      expect(firstResult.parts[0].functionResponse?.id).toBe(
        'shell_1__qwen_dup_2',
      );
      expect(firstResult.parts[0].functionResponse?.response).toEqual({
        error: expect.stringContaining(
          'Duplicate provider tool call id "shell_1"',
        ),
      });
      expect(secondResult.parts).toHaveLength(0);
      expect(secondResult.loopDetected).toBe(true);
      expect(toolLoopState.loopDetected).toBe(true);
      expect(toolLoopState.loopType).toBe(
        core.LoopType.GLOBAL_TOOL_CALL_DUPLICATE,
      );
      expect(toolLoopState.loopDetail).toEqual({
        loopReason: core.LoopReason.PROVIDER_DUPLICATE_ID,
      });
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledTimes(
        3,
      );
      expect(
        mockChatRecordingService.recordToolResult.mock.calls
          .slice(1)
          .map(([parts, metadata]) => ({
            callId: metadata.callId,
            responseId: parts[0]?.functionResponse?.id,
            error: parts[0]?.functionResponse?.response?.['error'],
            status: metadata.status,
            executionStatus: metadata.executionStatus,
          })),
      ).toEqual([
        {
          callId: 'shell_1__qwen_dup_3',
          responseId: 'shell_1__qwen_dup_3',
          error: expect.stringContaining(
            'loop detection stopped the current turn',
          ),
          status: 'error',
          executionStatus: 'not_started',
        },
        {
          callId: 'fresh_shell',
          responseId: 'fresh_shell',
          error: expect.stringContaining(
            'loop detection stopped the current turn',
          ),
          status: 'error',
          executionStatus: 'not_started',
        },
      ]);
      const updates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update);
      expect(
        updates.filter(
          (update) => !('_meta' in update && update._meta?.toolLifecycle),
        ),
      ).toHaveLength(3);
      expect(
        updates.filter(
          (update) => '_meta' in update && update._meta?.toolLifecycle,
        ),
      ).toHaveLength(2);
    });

    it('suppresses duplicate TodoWrite calls without emitting plan updates', async () => {
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        new Map([
          [
            'todo_1',
            core.getToolCallFingerprint(core.ToolNames.TODO_WRITE, {
              todos: [
                {
                  id: 'task-1',
                  content: 'Do not replay this',
                  status: 'pending',
                },
              ],
            }),
          ],
        ]),
      );
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'todo_1',
              name: core.ToolNames.TODO_WRITE,
              args: {
                todos: [
                  {
                    id: 'task-1',
                    content: 'Do not replay this',
                    status: 'pending',
                  },
                ],
              },
            },
          },
        ],
        new Set(['todo_1']),
        new Set<string>(),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-todo-dup', [
        duplicatePart.functionCall!,
      ]);

      expect(mockToolRegistry.getTool).not.toHaveBeenCalled();
      const { parts } = result;
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(parts[0].functionResponse?.id).toBe('todo_1__qwen_dup_2');
      expect(parts[0].functionResponse?.response).toEqual({
        error: expect.stringContaining(
          'Duplicate provider tool call id "todo_1"',
        ),
      });
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'todo_1__qwen_dup_2',
            status: 'failed',
          }),
        }),
      );
      expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'plan',
          }),
        }),
      );
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        parts,
        expect.objectContaining({
          callId: 'todo_1__qwen_dup_2',
          status: 'error',
        }),
      );
    });

    it('keeps duplicate synthetic responses ordered with executable calls', async () => {
      const execute = vi.fn(async () => ({
        llmContent: 'ran',
        returnDisplay: 'ran',
      }));
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { file_path: 'x.ts' },
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      const seededFingerprints = new Map([
        [
          'dup_mid',
          core.getToolCallFingerprint('read_file', { file_path: 'b.ts' }),
        ],
      ]);
      vi.mocked(mockChat.getHistoryToolCallFingerprints).mockReturnValue(
        seededFingerprints,
      );
      const [duplicatePart] = core.normalizeModelToolCallIds(
        [
          {
            functionCall: {
              id: 'dup_mid',
              name: 'read_file',
              args: { file_path: 'b.ts' },
            },
          },
        ],
        new Set(['dup_mid']),
        new Set<string>(),
      );

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-mixed-dup', [
        { id: 'call_a', name: 'read_file', args: { file_path: 'a.ts' } },
        duplicatePart.functionCall!,
        { id: 'call_c', name: 'read_file', args: { file_path: 'c.ts' } },
      ]);

      expect(execute).toHaveBeenCalledTimes(2);
      const { parts } = result;
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(parts.map((part) => part.functionResponse?.id)).toEqual([
        'call_a',
        'dup_mid__qwen_dup_2',
        'call_c',
      ]);
      expect(parts[1].functionResponse?.response).toEqual({
        error: expect.stringContaining(
          'Duplicate provider tool call id "dup_mid"',
        ),
      });
      // The accessor-owned map must stay untouched: runToolCalls records
      // admitted calls only into its own defensive copy. Without this pin,
      // dropping the copy would silently leak admitted-call entries into
      // the accessor's map (a real replay misclassification once the
      // accessor is ever memoized) while every test stays green.
      expect(seededFingerprints).toEqual(
        new Map([
          [
            'dup_mid',
            core.getToolCallFingerprint('read_file', { file_path: 'b.ts' }),
          ],
        ]),
      );
    });

    it('does not dedupe function calls with empty ids in one batch', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'result',
        returnDisplay: 'result',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read File',
        description: 'Read file',
        build: vi.fn().mockReturnValue({
          params: { file_path: 'a.ts' },
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const result = await (
        session as unknown as ToolCallInternals
      ).runToolCalls(new AbortController().signal, 'prompt-empty', [
        {
          id: '',
          name: 'read_file',
          args: { file_path: 'a.ts' },
        },
        {
          id: '',
          name: 'read_file',
          args: { file_path: 'b.ts' },
        },
      ]);

      expect(execute).toHaveBeenCalledTimes(2);
      expect(result.parts).toHaveLength(2);
      expect(result.stopAfterPermissionCancel).toBe(false);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledTimes(
        2,
      );
    });
  });

  describe('dispose', () => {
    type SessionInternals = {
      notificationQueue: unknown[];
      cronQueue: Array<{ prompt: string; source: 'cron' | 'loop' }>;
      notificationProcessing: boolean;
      disposed: boolean;
    };

    it('clears notification and cron queues, marks disposed, and unregisters callbacks', () => {
      const internals = session as unknown as SessionInternals;
      internals.notificationQueue.push({ taskId: 'stale' });
      internals.cronQueue.push({ prompt: 'stale-cron-prompt', source: 'cron' });
      internals.notificationProcessing = true;
      expect(internals.disposed).toBe(false);

      session.dispose();

      expect(internals.disposed).toBe(true);
      expect(internals.notificationQueue).toHaveLength(0);
      expect(internals.cronQueue).toHaveLength(0);
      expect(internals.notificationProcessing).toBe(false);
      expect(mockBackgroundTaskRegistry.abortAll).toHaveBeenCalledWith({
        notify: false,
      });
      expect(
        mockBackgroundTaskRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockMonitorRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockBackgroundShellRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockWorkflowRunRegistry.setCompletionCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockWorkflowRunRegistry.clearStatusChangeCallback,
      ).toHaveBeenCalledWith(expect.any(Function));
      // R7-10: mirror the agent registry. A workflow run that outlives
      // its session's removal is invisible to the delete-history liveness
      // gate, and its settlement snapshot write recreates history a
      // sibling session just deleted. Abort must precede the callback
      // teardown so the cancellation still reaches this session's own
      // bookkeeping.
      expect(mockWorkflowRunRegistry.abortAll).toHaveBeenCalled();
      expect(
        mockWorkflowRunRegistry.abortAll.mock.invocationCallOrder.at(-1),
      ).toBeLessThan(
        mockWorkflowRunRegistry.setCompletionCallback.mock.invocationCallOrder.at(
          -1,
        )!,
      );
    });

    it('aborts an active notificationAbortController and nulls the reference', () => {
      type NotificationInternals = {
        notificationAbortController: AbortController | null;
      };
      const internals = session as unknown as NotificationInternals;
      const ac = new AbortController();
      internals.notificationAbortController = ac;

      session.dispose();

      expect(ac.signal.aborted).toBe(true);
      expect(internals.notificationAbortController).toBeNull();
    });

    it('aborts cronAbortController and resets cron state on dispose', () => {
      type CronInternals = {
        cronAbortController: AbortController | null;
        cronProcessing: boolean;
        cronCompletion: Promise<void> | null;
      };
      const internals = session as unknown as CronInternals;
      const ac = new AbortController();
      internals.cronAbortController = ac;
      internals.cronProcessing = true;
      internals.cronCompletion = Promise.resolve();

      session.dispose();

      expect(ac.signal.aborted).toBe(true);
      expect(internals.cronAbortController).toBeNull();
      expect(internals.cronProcessing).toBe(false);
      expect(internals.cronCompletion).toBeNull();
    });

    it('is idempotent — repeated dispose() calls do not throw or re-register', () => {
      const internals = session as unknown as SessionInternals;
      session.dispose();
      const callsAfterFirst =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.length;

      expect(() => session.dispose()).not.toThrow();
      expect(internals.disposed).toBe(true);
      expect(internals.notificationQueue).toHaveLength(0);
      expect(internals.cronQueue).toHaveLength(0);
      // The second dispose still unregisters (passes undefined again), which
      // is harmless. We only care that no surprise re-registration occurs.
      const last =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(-1);
      expect(last?.[0]).toBeUndefined();
      expect(
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.length,
      ).toBeGreaterThanOrEqual(callsAfterFirst);
    });

    it('guards #drainNotificationQueue from processing after dispose', () => {
      type DrainInternals = {
        disposed: boolean;
        notificationQueue: unknown[];
        notificationProcessing: boolean;
      };
      const internals = session as unknown as DrainInternals;

      // Simulate a queued notification, then dispose before drain runs
      internals.notificationQueue.push({ taskId: 'late-arrival' });
      session.dispose();

      // After dispose, the queue is cleared and processing is stopped
      expect(internals.notificationQueue).toHaveLength(0);
      expect(internals.notificationProcessing).toBe(false);
      expect(internals.disposed).toBe(true);
    });
  });

  describe('automatic drain serialization on the history mutation gate', () => {
    // Mirrors acpAgent's `runExclusiveHistoryMutation` FIFO gate that the
    // interactive prompt + checkpoint transaction runs under, and that
    // Session receives as `runExclusiveAutomaticHistoryMutation`.
    function createGatedRunner() {
      let tail: Promise<void> = Promise.resolve();
      const run = <T>(operation: () => Promise<T>): Promise<T> => {
        const previous = tail;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        tail = previous.then(() => gate);
        return (async () => {
          await previous;
          try {
            return await operation();
          } finally {
            release();
          }
        })();
      };
      return run;
    }

    async function settlePendingWork() {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it('waits for an interactive checkpoint mutation before draining cron', async () => {
      const runExclusive = createGatedRunner();
      const gateSession = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
        runExclusive,
      );
      vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValue(
        new Error('turn admission closed for gate test'),
      );
      let fireCron:
        | ((job: { id: string; prompt: string; cronExpr: string }) => void)
        | undefined;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn((callback: typeof fireCron) => {
          fireCron = callback;
        }),
        stop: vi.fn(),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      gateSession.startCronScheduler();
      await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalled());

      // The interactive prompt + checkpoint transaction holds the gate.
      let releaseCheckpoint!: () => void;
      const checkpointGate = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const checkpointMutation = runExclusive(() => checkpointGate);

      fireCron?.({ id: 'task-1', prompt: 'scheduled', cronExpr: '* * * * *' });
      await settlePendingWork();

      // The cron drain queued behind the checkpoint mutation and its
      // exclusive body has not started.
      expect(mockConfig.assertCanStartTurn).not.toHaveBeenCalled();

      releaseCheckpoint();
      await checkpointMutation;
      await vi.waitFor(() =>
        expect(mockConfig.assertCanStartTurn).toHaveBeenCalled(),
      );

      gateSession.dispose();
    });

    it('waits for an interactive checkpoint mutation before draining notifications', async () => {
      const runExclusive = createGatedRunner();
      const gateSession = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
        runExclusive,
      );
      vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValue(
        new Error('turn admission closed for gate test'),
      );
      const notify = vi
        .mocked(mockBackgroundTaskRegistry.setNotificationCallback)
        .mock.calls.at(-1)?.[0];
      expect(notify).toBeDefined();

      // The interactive prompt + checkpoint transaction holds the gate.
      let releaseCheckpoint!: () => void;
      const checkpointGate = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const checkpointMutation = runExclusive(() => checkpointGate);

      notify?.('Agent done', 'agent finished', {
        agentId: 'agent-1',
        status: 'completed',
      });
      await settlePendingWork();

      // The notification drain queued behind the checkpoint mutation and
      // its exclusive body has not started.
      expect(mockConfig.assertCanStartTurn).not.toHaveBeenCalled();

      releaseCheckpoint();
      await checkpointMutation;
      await vi.waitFor(() =>
        expect(mockConfig.assertCanStartTurn).toHaveBeenCalled(),
      );

      gateSession.dispose();
    });

    it('waits for an interactive checkpoint mutation before draining a Goal continuation', async () => {
      const runExclusive = createGatedRunner();
      const gateSession = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
        runExclusive,
      );
      const permit: core.GoalTurnPermit = {
        goalId: 'goal-1',
        revision: 1,
        turnId: 'turn-behind-history-mutation',
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
        turnKey === 'goal-runtime:turn-behind-history-mutation'
          ? permit
          : undefined,
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      let releaseCheckpoint!: () => void;
      const checkpointGate = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const checkpointMutation = runExclusive(() => checkpointGate);

      await boundGoalHost!.startGoalTurn({
        permit,
        continuationContext: 'check weather',
      });
      await settlePendingWork();

      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalled();
      expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();

      releaseCheckpoint();
      await checkpointMutation;
      await vi.waitFor(() => {
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
      });

      gateSession.dispose();
    });
  });

  describe('daemon Todo Stop Guard', () => {
    const pendingTodos = [
      { id: 'task-1', content: 'finish task', status: 'pending' as const },
    ];
    let guardPromptCounter = 0;
    let lastGuardPromptId = '';

    function rebuildSessionWithGuard(
      options: {
        safe?: boolean;
        bare?: boolean;
        plan?: boolean;
        disableHooks?: boolean;
        todoWriteEnabled?: boolean;
      } = {},
    ) {
      session.dispose();
      (mockSettings as unknown as { merged: Record<string, unknown> }).merged =
        {
          experimental: { todoStopGuard: true },
          ...(options.todoWriteEnabled === false
            ? {}
            : { tools: { todoWrite: { enabled: true } } }),
        };
      mockConfig.getBareMode = vi.fn().mockReturnValue(options.bare ?? false);
      mockConfig.isSafeMode = vi.fn().mockReturnValue(options.safe ?? false);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(
          options.plan ? ApprovalMode.PLAN : ApprovalMode.DEFAULT,
        );
      mockConfig.getDisableAllHooks = vi
        .fn()
        .mockReturnValue(options.disableHooks ?? false);
      session = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
      );
    }

    function installPendingTodoTool(options: { trusted?: boolean } = {}) {
      const execute = vi.fn().mockResolvedValue({
        llmContent: JSON.stringify(pendingTodos),
        returnDisplay: {
          type: 'todo_list',
          todos: pendingTodos,
          changes: {},
        },
      });
      mockToolRegistry.getTool.mockReturnValue({
        constructor: {
          name: options.trusted === false ? 'DiscoveredTool' : 'TodoWriteTool',
        },
        name: core.ToolNames.TODO_WRITE,
        kind: options.trusted === false ? core.Kind.Other : core.Kind.Think,
        displayName: 'TodoWrite',
        description: 'Write todos',
        build: vi.fn().mockImplementation((args) => ({
          params: args,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Write todos'),
          toolLocations: vi.fn().mockReturnValue([]),
        })),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });
      return execute;
    }

    function queuePendingTodoThenNaturalStops() {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-1',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
    }

    async function runGuardPrompt(perTask = false) {
      lastGuardPromptId = `test-session-id########guard-${++guardPromptCounter}`;
      return session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'finish everything' }],
          ...(perTask
            ? {
                _meta: {
                  [CHANNEL_PROMPT_META_KEY]: true,
                  [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
                },
              }
            : {}),
        },
        {
          version: 1,
          sessionId: 'test-session-id',
          promptId: lastGuardPromptId,
        },
      );
    }

    type GuardDrainResponse = {
      messages?: unknown[];
      items?: unknown[];
      hasQueuedPrompt?: boolean;
    };

    function mockGuardBridge(
      drain: () => GuardDrainResponse | Promise<GuardDrainResponse>,
      claim?: (
        params: unknown,
        lastDrain: GuardDrainResponse,
      ) => unknown | Promise<unknown>,
    ) {
      let lastDrain: GuardDrainResponse = {
        messages: [],
        hasQueuedPrompt: false,
      };
      vi.mocked(mockClient.extMethod).mockImplementation(
        async (method, params) => {
          if (method === '_qwencode/start_turn') return { accepted: true };
          if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
            if (claim) {
              return (await claim(params, lastDrain)) as Record<
                string,
                unknown
              >;
            }
            return lastDrain.hasQueuedPrompt
              ? { claimed: false, hasQueuedPrompt: true }
              : { claimed: true, hasQueuedPrompt: false };
          }
          lastDrain = await drain();
          return lastDrain;
        },
      );
    }

    function mockGuardDrainResponses(
      ...responses: Array<
        | GuardDrainResponse
        | (() => GuardDrainResponse | Promise<GuardDrainResponse>)
      >
    ) {
      let index = 0;
      mockGuardBridge(async () => {
        const next = responses[Math.min(index++, responses.length - 1)];
        if (typeof next === 'function') return next();
        return index > responses.length
          ? { ...next, messages: [], items: [] }
          : next;
      });
    }

    function bindDaemonGuardBridge(promptId: string) {
      const entry: Pick<
        BridgeClientSessionEntry,
        | 'sessionId'
        | 'promptActive'
        | 'activePromptId'
        | 'pendingPromptList'
        | 'midTurnMessageQueue'
        | 'settledMidTurnMessageIds'
        | 'events'
        | 'backgroundTurn'
      > = {
        sessionId: 'test-session-id',
        promptActive: true,
        activePromptId: promptId,
        pendingPromptList: [
          {
            promptId,
            queuedAt: Date.now(),
            text: 'finish the task',
            state: 'running',
            abortController: new AbortController(),
          },
        ],
        midTurnMessageQueue: [],
        settledMidTurnMessageIds: [],
        events: new EventBus(),
      };
      const client = new BridgeClient(
        () => entry as BridgeClientSessionEntry,
        () => undefined,
        { request: vi.fn(), cancelForPrompt: vi.fn() },
        0,
        Infinity,
      );
      vi.mocked(mockClient.extMethod).mockImplementation((method, params) =>
        method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD ||
        method === 'craft/drainMidTurnQueue' ||
        method === '_qwencode/start_turn'
          ? client.extMethod(method, params)
          : Promise.resolve({}),
      );
      vi.mocked(mockClient.extNotification).mockImplementation(
        (method, params) => client.extNotification(method, params),
      );
      return entry;
    }

    it('disables the guard and warns when todo_write is disabled', async () => {
      debugLoggerWarnSpy.mockClear();
      rebuildSessionWithGuard({ todoWriteEnabled: false });
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        'experimental.todoStopGuard requires tools.todoWrite.enabled; the Todo Stop Guard is disabled.',
      );
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it.each([
      ['safe mode', { safe: true }],
      ['bare mode', { bare: true }],
    ] as const)('suppresses the missing Todo warning in %s', (_name, mode) => {
      debugLoggerWarnSpy.mockClear();
      rebuildSessionWithGuard({ ...mode, todoWriteEnabled: false });

      expect(debugLoggerWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('tools.todoWrite.enabled'),
      );
    });

    it('returns actionable Todo enablement guidance from daemon tool calls', async () => {
      rebuildSessionWithGuard({ todoWriteEnabled: false });
      mockToolRegistry.getTool.mockReturnValue(undefined);
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      const followUp = vi.mocked(mockChat.sendMessageStream).mock
        .calls[1][1] as {
        message: unknown;
      };
      expect(JSON.stringify(followUp.message)).toContain(
        'tools.todoWrite.enabled',
      );
    });

    it('cleans up an admitted retry cancelled during previous-turn drain', async () => {
      rebuildSessionWithGuard();
      let releasePreviousTurn!: () => void;
      const previousTurn = new Promise<void>((resolve) => {
        releasePreviousTurn = resolve;
      });
      const cancellation = new AbortController();
      const internals = session as unknown as {
        pendingPrompt: AbortController | null;
        pendingPromptCompletion: Promise<void> | null;
        todoStopGuard: {
          hasTrustedUnfinishedState: boolean;
          isHardSuspended: boolean;
          observeTodoWrite(resultDisplay: unknown, allowArm: boolean): boolean;
        };
      };
      internals.todoStopGuard.observeTodoWrite(
        { type: 'todo_list', todos: pendingTodos },
        true,
      );
      expect(internals.todoStopGuard.hasTrustedUnfinishedState).toBe(true);
      internals.pendingPromptCompletion = previousTurn;

      const prompt = session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'retry after cancellation' }],
          _meta: { 'qwen.daemon.retry': true },
        } as Parameters<typeof session.prompt>[0],
        undefined,
        cancellation.signal,
      );
      await vi.waitFor(() => {
        expect(internals.pendingPrompt).not.toBeNull();
        expect(internals.todoStopGuard.isHardSuspended).toBe(false);
      });

      cancellation.abort();
      releasePreviousTurn();

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      expect(internals.pendingPrompt).toBeNull();
      expect(internals.todoStopGuard.isHardSuspended).toBe(true);
      await expect(session.cancelPendingPrompt()).rejects.toThrow(
        'Not currently generating',
      );
    });

    function createDeferredAbortStream() {
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let rejectStream!: (reason?: unknown) => void;
      const gate = new Promise<never>((_resolve, reject) => {
        rejectStream = reject;
      });
      async function* stream() {
        markStarted();
        yield await gate;
      }
      return {
        responseStream: stream(),
        started,
        abort(errorName = 'AbortError') {
          const error = new Error('aborted');
          error.name = errorName;
          rejectStream(error);
        },
      };
    }

    it('treats dispose as controlled cancellation and rejects late Todo re-arming', async () => {
      rebuildSessionWithGuard();
      const fireStopFailureEvent = vi.fn().mockResolvedValue(undefined);
      mockConfig.getHookSystem = vi.fn().mockReturnValue({
        fireStopFailureEvent,
      });
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'StopFailure');
      const aborting = createDeferredAbortStream();
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(aborting.responseStream);

      const prompt = runGuardPrompt();
      await aborting.started;
      session.dispose();
      aborting.abort('Error');

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      const internals = session as unknown as {
        todoStopGuard: {
          isHardSuspended: boolean;
          observeTodoWrite(resultDisplay: unknown, allowArm: boolean): boolean;
          decide(hasRelevantBackgroundInput: boolean): { kind: string };
        };
      };
      expect(
        internals.todoStopGuard.observeTodoWrite(
          { type: 'todo_list', todos: pendingTodos },
          true,
        ),
      ).toBe(true);
      expect(internals.todoStopGuard.isHardSuspended).toBe(true);
      expect(internals.todoStopGuard.decide(false)).toEqual({
        kind: 'inactive',
      });
      expect(fireStopFailureEvent).not.toHaveBeenCalled();
    });

    it('surfaces an AbortError when the prompt signal was not aborted', async () => {
      rebuildSessionWithGuard();
      const error = new Error('provider aborted unexpectedly');
      error.name = 'AbortError';
      async function* failingStream() {
        yield* [];
        throw error;
      }
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(failingStream());

      await expect(runGuardPrompt()).rejects.toThrow(
        'provider aborted unexpectedly',
      );
    });

    it('is off by default', async () => {
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('does not publish rejected Todo arguments as a live plan', async () => {
      const execute = installPendingTodoTool();
      execute.mockResolvedValue({
        llmContent: 'Failed to modify todos',
        returnDisplay:
          'Error writing todos: Todo dependency graph contains a cycle',
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) => params.update.sessionUpdate === 'plan',
          ),
      ).toBe(false);
    });

    it('preserves feature-off Stop hook loop reporting before token rejection', async () => {
      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(3);
      mockLlmClient.tryCompressChat.mockResolvedValue({
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      });
      const highUsageStream = () =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              usageMetadata: {
                totalTokenCount: 101,
                promptTokenCount: 101,
              },
            },
          },
        ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(highUsageStream())
        .mockResolvedValueOnce(highUsageStream());
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? {
                  decision: 'block',
                  reason: 'feature-off hook continuation',
                }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await expect(runGuardPrompt()).resolves.toEqual({
        stopReason: 'max_tokens',
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update._meta?.['stopHookLoop'])
          .filter((meta) => meta !== undefined),
      ).toContainEqual(
        expect.objectContaining({
          iterationCount: 2,
          reasons: [
            'feature-off hook continuation',
            'feature-off hook continuation',
          ],
        }),
      );
    });

    it('reports cancellation before a feature-off Stop loop starts', async () => {
      let enterWait!: () => void;
      const waitStarted = new Promise<void>((resolve) => {
        enterWait = resolve;
      });
      let releaseWait!: () => void;
      const waitGate = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      session.messageRewriter = {
        interceptUpdate: vi.fn().mockResolvedValue(undefined),
        waitForPendingRewrites: vi.fn(async () => {
          enterWait();
          await waitGate;
        }),
      } as unknown as NonNullable<Session['messageRewriter']>;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      const prompt = runGuardPrompt();
      await waitStarted;
      await session.cancelPendingPrompt();
      releaseWait();

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    it('lets cancellation win while a loop-detected Stop continuation is preserved', async () => {
      mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
      mockConfig.isMaxToolCallsPerTurnExplicit = vi.fn().mockReturnValue(true);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  { id: 'loop-1', name: 'read_file', args: { path: 'a' } },
                  { id: 'loop-2', name: 'read_file', args: { path: 'b' } },
                ],
              },
            },
          ]),
        );
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: { decision: 'block', reason: 'continue once' },
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      let startDrain!: () => void;
      const drainStarted = new Promise<void>((resolve) => {
        startDrain = resolve;
      });
      let releaseDrain!: () => void;
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      mockClient.extMethod = vi.fn(async () => {
        startDrain();
        await drainGate;
        return { messages: [] };
      });

      const prompt = runGuardPrompt();
      await drainStarted;
      await session.cancelPendingPrompt();
      releaseDrain();

      await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    });

    it('rejects a foreground turn whose Stop continuation trips loop protection', async () => {
      // Pins rejectOnLoopDetected=true at the foreground #handleStopHookLoop
      // call site: without it this turn would resolve end_turn.
      mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
      mockConfig.isMaxToolCallsPerTurnExplicit = vi.fn().mockReturnValue(true);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  { id: 'loop-1', name: 'read_file', args: { path: 'a' } },
                  { id: 'loop-2', name: 'read_file', args: { path: 'b' } },
                ],
              },
            },
          ]),
        );
      const messageBus = {
        request: vi.fn().mockResolvedValue({
          success: true,
          output: { decision: 'block', reason: 'continue once' },
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      mockClient.extMethod = vi.fn(async () => ({ messages: [] }));

      await expect(runGuardPrompt()).rejects.toMatchObject({
        message: LOOP_DETECTED_TURN_ERROR_MESSAGE,
        data: expect.objectContaining({
          code: 'LOOP_DETECTED',
          loopType: core.LoopType.TURN_TOOL_CALL_CAP,
        }),
      });
      expect(logLoopDetectedSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
        }),
        {},
      );
    });

    it('runs exactly two continuations and emits replayable status', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const guardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardUpdates).toHaveLength(3);
      expect(guardUpdates.map((update) => update._meta?.['attempt'])).toEqual([
        1, 2, 2,
      ]);
      expect(guardUpdates[0]?._meta).toMatchObject({
        qwenDiscreteMessage: true,
        maxAttempts: 2,
        unfinishedCount: 1,
      });
      expect(
        guardUpdates.every(
          (update) =>
            update.content.type !== 'text' ||
            !update.content.text.includes('finish task'),
        ),
      ).toBe(true);

      const firstContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      const finalContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(firstContinuation.message).join('\n')).toContain(
        'Do not ask the user whether to continue.',
      );
      expect(textParts(finalContinuation.message).join('\n')).toContain(
        'This is the final automatic continuation.',
      );
    });

    it('does not arm from Todo arguments when the result is not structured', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockResolvedValue({
        llmContent: 'Todo updated',
        returnDisplay: 'Todo updated',
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('does not arm from a discovered tool that shadows todo_write', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool({ trusted: false });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('counts a started stream that fails and resumes only the final attempt on trusted retry', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const failedGuardStream = createFailingStream('guard stream failed');
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-stream-error',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(failedGuardStream)
        .mockResolvedValue(createEmptyStream());

      await expect(runGuardPrompt()).rejects.toThrow('guard stream failed');
      const firstGuardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(
        firstGuardUpdates.map((update) => update._meta?.['attempt']),
      ).toEqual([1]);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'retry the failed stream' }],
        _meta: { 'qwen.daemon.retry': true },
      } as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      const allGuardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(allGuardAttempts).toEqual([1, 2, 2]);
    });

    it('resumes an API-paused chain for its related background result', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      const failedGuardStream = createFailingStream(
        'guard stream failed after background result queued',
        () => {
          mockBackgroundTaskRegistry.getAll.mockReturnValue([
            {
              id: 'related-after-api-error',
              description: 'related-after-api-error',
              isBackgrounded: true,
              status: 'completed',
              notified: false,
            },
          ]);
          callback('background done', '<related-after-api-error />', {
            agentId: 'related-after-api-error',
            status: 'completed',
          });
        },
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-related-result',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(failedGuardStream)
        .mockResolvedValue(createEmptyStream());

      await expect(runGuardPrompt()).rejects.toThrow(
        'guard stream failed after background result queued',
      );

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      });
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it('drains a mid-turn background completion when an unarmed turn errors out', async () => {
      rebuildSessionWithGuard();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      const failedStream = createFailingStream('unarmed stream failed', () => {
        callback('background done', '<unrelated-after-unarmed-error />', {
          agentId: 'unrelated-after-unarmed-error',
          status: 'completed',
        });
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(failedStream)
        .mockResolvedValue(createEmptyStream());

      await expect(runGuardPrompt()).rejects.toThrow('unarmed stream failed');

      // A background completion queued mid-turn must not be stranded when the
      // owning turn errors out: the error path drains it so the session can
      // return to idle instead of holding activeWorkState forever.
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      const automaticCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[1]?.[1] as { message: Part[] };
      expect(textParts(automaticCall.message).join('\n')).toContain(
        '<unrelated-after-unarmed-error />',
      );
    });

    it('clears a failed guard chain when a new ordinary prompt starts', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const failedGuardStream = createFailingStream('guard stream failed');
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-new-prompt',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(failedGuardStream)
        .mockResolvedValue(createEmptyStream());

      await expect(runGuardPrompt()).rejects.toThrow('guard stream failed');
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'unrelated ordinary prompt' }],
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const guardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardUpdates.map((update) => update._meta?.['attempt'])).toEqual([
        1,
      ]);
    });

    it('recaptures the background baseline when retry has no trusted Guard state', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'task-from-cleared-chain',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      session.clearTodoStopGuardTrust();
      queuePendingTodoThenNaturalStops();
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'trusted retry after trust clear' }],
        _meta: { 'qwen.daemon.retry': true },
      } as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update)
          .filter(
            (update) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update._meta?.['source'] === 'todo_stop_guard',
          )
          .map((update) => update._meta?.['attempt']),
      ).toEqual([1, 2, 2]);
    });

    it.each([
      ['safe mode', { safe: true }],
      ['bare mode', { bare: true }],
      ['Approval plan mode', { plan: true }],
    ])('is forced off in %s', async (_label, options) => {
      rebuildSessionWithGuard(options);
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('clears stale FIFO priority when a Plan prompt begins', async () => {
      rebuildSessionWithGuard({ plan: true });
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        todoStopGuardQueuedPromptOwnerPromptId?: string;
      };
      internals.todoStopGuardQueuedPromptPriority = true;
      internals.todoStopGuardQueuedPromptOwnerPromptId = lastGuardPromptId;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();

      expect(internals.todoStopGuardQueuedPromptPriority).toBe(false);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    it('keeps observed FIFO priority when an out-of-band mode change clears Guard trust', async () => {
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        todoStopGuardQueuedPromptOwnerPromptId?: string;
      };
      lastGuardPromptId = 'test-session-id########observed-fifo-owner';
      internals.todoStopGuardQueuedPromptPriority = true;
      internals.todoStopGuardQueuedPromptOwnerPromptId = lastGuardPromptId;

      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });

      expect(internals.todoStopGuardQueuedPromptPriority).toBe(true);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);
      expect(internals.todoStopGuardQueuedPromptPriority).toBe(false);
    });

    it('keeps FIFO priority when Guard trust clears during queue inspection', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let queueInspectionStarted!: () => void;
      const queueInspectionStart = new Promise<void>((resolve) => {
        queueInspectionStarted = resolve;
      });
      let resolveQueueInspection!: (value: {
        messages: never[];
        hasQueuedPrompt: boolean;
      }) => void;
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        () =>
          new Promise((resolve) => {
            resolveQueueInspection = resolve;
            queueInspectionStarted();
          }),
      );

      const prompt = runGuardPrompt();
      await queueInspectionStart;
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });
      resolveQueueInspection({ messages: [], hasQueuedPrompt: true });
      await prompt;

      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
      };
      expect(internals.todoStopGuardQueuedPromptPriority).toBe(true);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);
    });

    it('does not let a late Todo write re-arm after Guard trust clears as its stream starts', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      let guardSendStarted!: () => void;
      const guardSendStart = new Promise<void>((resolve) => {
        guardSendStarted = resolve;
      });
      let resolveGuardStream!: (
        stream: ReturnType<typeof createStreamWithChunks>,
      ) => void;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'arm-before-trust-clear',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveGuardStream = resolve;
              guardSendStarted();
            }),
        )
        .mockImplementation(async () => createEmptyStream());

      const prompt = runGuardPrompt();
      await guardSendStart;
      session.clearTodoStopGuardTrust();
      resolveGuardStream(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'tool-after-trust-clear',
                  name: core.ToolNames.TODO_WRITE,
                  args: { todos: pendingTodos },
                },
              ],
            },
          },
        ]),
      );
      await prompt;

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update)
          .filter(
            (update) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update._meta?.['source'] === 'todo_stop_guard',
          )
          .map((update) => update._meta?.['attempt']),
      ).toEqual([]);
    });

    it('drains deferred automatic work after an active Guard is invalidated and the prompt errors', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-before-invalidation-error',
          description: 'old-before-invalidation-error',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      installPendingTodoTool();
      let guardSendStarted!: () => void;
      const guardSendStart = new Promise<void>((resolve) => {
        guardSendStarted = resolve;
      });
      let resolveGuardStream!: (
        stream: ReturnType<typeof createFailingStream>,
      ) => void;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-invalidation-error',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveGuardStream = resolve;
              guardSendStarted();
            }),
        )
        .mockResolvedValue(createEmptyStream());

      const prompt = runGuardPrompt();
      await guardSendStart;
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-before-invalidation-error',
          description: 'old-before-invalidation-error',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('old background done', '<old-after-invalidation-error />', {
        agentId: 'old-before-invalidation-error',
        status: 'completed',
      });
      session.clearTodoStopGuardTrust();
      resolveGuardStream(
        createFailingStream('guard failed after invalidation'),
      );

      await expect(prompt).rejects.toThrow('guard failed after invalidation');
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });
      const automaticCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(automaticCall.message).join('\n')).toContain(
        '<old-after-invalidation-error />',
      );
    });

    it('still runs when external hooks are disabled', async () => {
      rebuildSessionWithGuard({ disableHooks: true });
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
    });

    it('preserves drained input without consuming or reviving the guard when token limits block the continuation stream', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['direction drained before the token-limit check'],
          hasQueuedPrompt: false,
        },
      );
      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
      mockLlmClient.tryCompressChat
        .mockResolvedValueOnce({
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        })
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

      await expect(runGuardPrompt()).resolves.toEqual({
        stopReason: 'max_tokens',
      });
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            text: '\n[User message received during tool execution]: direction drained before the token-limit check',
          },
        ],
      });

      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(0);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'new-after-token-limit',
        status: 'completed',
      });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });
    });

    it('preserves pre-compression drain input when a queued prompt wins the claim', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['context drained at the final claim boundary'],
          hasQueuedPrompt: true,
        },
      );

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            text: '\n[User message received during tool execution]: context drained at the final claim boundary',
          },
        ],
      });
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('revalidates plan mode before claiming a continuation', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let preparationStarted!: () => void;
      const preparationStartedPromise = new Promise<void>((resolve) => {
        preparationStarted = resolve;
      });
      let releasePreparation!: () => void;
      const preparationGate = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let drainCount = 0;
      mockGuardBridge(async () => {
        if (++drainCount === 2) {
          preparationStarted();
          await preparationGate;
        }
        return { messages: [], hasQueuedPrompt: false };
      });

      const prompt = runGuardPrompt();
      await preparationStartedPromise;
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });
      releasePreparation();
      await prompt;

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it.each([
      ['omits queued-prompt state', { messages: [] }],
      [
        'contains an invalid message entry',
        { messages: [42], hasQueuedPrompt: false },
      ],
      [
        'contains an invalid structured content block',
        {
          items: [{ content: [{ type: 'unsupported' }] }],
          hasQueuedPrompt: false,
        },
      ],
    ])('fails closed when watched drain %s', async (_label, response) => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let claimCount = 0;
      mockGuardBridge(
        async () => response,
        async () => {
          claimCount++;
          return { claimed: true, hasQueuedPrompt: false };
        },
      );

      await runGuardPrompt();

      expect(claimCount).toBe(0);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it.each([
      ['an invalid response', async () => ({ claimed: 'yes' })],
      [
        'an old client method-not-found error',
        async () => {
          const error = new Error('Method not found');
          Object.assign(error, { code: -32601 });
          throw error;
        },
      ],
    ])(
      'fails closed when continuation claim returns %s',
      async (_label, claim) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        mockGuardBridge(
          async () => ({ messages: [], hasQueuedPrompt: false }),
          claim,
        );

        await runGuardPrompt();

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.some(
              ([params]) =>
                params.update.sessionUpdate === 'agent_message_chunk' &&
                params.update._meta?.['source'] === 'todo_stop_guard',
            ),
        ).toBe(false);
      },
    );

    it('fails closed when continuation claim times out', async () => {
      vi.useFakeTimers();
      try {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        let claimStarted!: () => void;
        const claimStartedPromise = new Promise<void>((resolve) => {
          claimStarted = resolve;
        });
        mockGuardBridge(
          async () => ({ messages: [], hasQueuedPrompt: false }),
          async () => {
            claimStarted();
            return new Promise(() => {});
          },
        );

        const prompt = runGuardPrompt();
        await claimStartedPromise;
        await vi.advanceTimersByTimeAsync(2_000);
        await prompt;

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.some(
              ([params]) =>
                params.update.sessionUpdate === 'agent_message_chunk' &&
                params.update._meta?.['source'] === 'todo_stop_guard',
            ),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not send a continuation when hard-suspended during claim', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let claimStarted!: () => void;
      const claimStartedPromise = new Promise<void>((resolve) => {
        claimStarted = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      mockGuardBridge(
        async () => ({ messages: [], hasQueuedPrompt: false }),
        async () => {
          claimStarted();
          await claimGate;
          return { claimed: true, hasQueuedPrompt: false };
        },
      );

      const prompt = runGuardPrompt();
      await claimStartedPromise;
      session.hardSuspendTodoStopGuard();
      releaseClaim();
      await prompt;

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('preserves queued-prompt priority when hard-suspended during claim', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let claimStarted!: () => void;
      const claimStartedPromise = new Promise<void>((resolve) => {
        claimStarted = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      mockGuardBridge(
        async () => ({ messages: [], hasQueuedPrompt: false }),
        async () => {
          claimStarted();
          await claimGate;
          return { claimed: false, hasQueuedPrompt: true };
        },
      );

      const prompt = runGuardPrompt();
      await claimStartedPromise;
      session.hardSuspendTodoStopGuard();
      releaseClaim();
      await prompt;

      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        todoStopGuardQueuedPromptOwnerPromptId?: string;
      };
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(internals.todoStopGuardQueuedPromptPriority).toBe(true);
      expect(internals.todoStopGuardQueuedPromptOwnerPromptId).toBe(
        lastGuardPromptId,
      );
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('does not restore queued-prompt priority while the session is closing', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let claimStarted!: () => void;
      const claimStartedPromise = new Promise<void>((resolve) => {
        claimStarted = resolve;
      });
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      mockGuardBridge(
        async () => ({ messages: [], hasQueuedPrompt: false }),
        async () => {
          claimStarted();
          await claimGate;
          return { claimed: false, hasQueuedPrompt: true };
        },
      );

      const prompt = runGuardPrompt();
      await claimStartedPromise;
      const releaseClose = session.beginClose();
      session.hardSuspendTodoStopGuard();
      releaseClaim();
      await prompt;

      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        todoStopGuardQueuedPromptOwnerPromptId?: string;
      };
      expect(internals.todoStopGuardQueuedPromptPriority).toBe(false);
      expect(internals.todoStopGuardQueuedPromptOwnerPromptId).toBeUndefined();
      releaseClose();
    });

    it.each([false, true])(
      'consumes a queued-prompt release before the claim response with per_task=%s',
      async (perTask) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        let claimStarted!: () => void;
        const claimStartedPromise = new Promise<void>((resolve) => {
          claimStarted = resolve;
        });
        let resolveClaim!: (value: {
          claimed: false;
          hasQueuedPrompt: true;
        }) => void;
        mockGuardBridge(
          async () => ({ messages: [], hasQueuedPrompt: false }),
          () =>
            new Promise<{ claimed: false; hasQueuedPrompt: true }>(
              (resolve) => {
                resolveClaim = resolve;
                claimStarted();
              },
            ),
        );

        const prompt = runGuardPrompt(perTask);
        await claimStartedPromise;
        const callback =
          mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
            -1,
          )?.[0] as (
            displayText: string,
            modelText: string,
            meta: { agentId: string; status: string },
          ) => void;
        callback('background done', '<after-early-release />', {
          agentId: 'after-early-release',
          status: 'completed',
        });
        resolveClaim({ claimed: false, hasQueuedPrompt: true });
        expect(
          session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
        ).toBe(true);
        expect((await prompt).stopReason).toBe('end_turn');

        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        });
        const internals = session as unknown as {
          todoStopGuardQueuedPromptPriority: boolean;
          todoStopGuardQueuedPromptOwnerPromptId?: string;
          todoStopGuardClaimOwnerCounts: Map<string, number>;
          todoStopGuardReleasedDuringClaim: Set<string>;
        };
        expect(internals.todoStopGuardQueuedPromptPriority).toBe(false);
        expect(
          internals.todoStopGuardQueuedPromptOwnerPromptId,
        ).toBeUndefined();
        expect(internals.todoStopGuardClaimOwnerCounts.size).toBe(0);
        expect(internals.todoStopGuardReleasedDuringClaim.size).toBe(0);
        expect(
          session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
        ).toBe(false);
        const notificationCall = vi.mocked(mockChat.sendMessageStream).mock
          .calls[2]?.[1] as { message: Part[] };
        expect(textParts(notificationCall.message).join('\n')).toContain(
          '<after-early-release />',
        );
      },
    );

    it('does not reopen queue admission after a continuation claim', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let claimCount = 0;
      let queuedAfterClaim = false;
      mockGuardBridge(
        async () => ({
          messages: [],
          hasQueuedPrompt: queuedAfterClaim,
        }),
        async () => {
          claimCount++;
          return queuedAfterClaim
            ? { claimed: false, hasQueuedPrompt: true }
            : { claimed: true, hasQueuedPrompt: false };
        },
      );
      let compressionStarted!: () => void;
      const compressionStartedPromise = new Promise<void>((resolve) => {
        compressionStarted = resolve;
      });
      let releaseCompression!: () => void;
      const compressionGate = new Promise<void>((resolve) => {
        releaseCompression = resolve;
      });
      const noCompression = {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      };
      mockLlmClient.tryCompressChat
        .mockResolvedValueOnce(noCompression)
        .mockResolvedValueOnce(noCompression)
        .mockImplementationOnce(async () => {
          compressionStarted();
          await compressionGate;
          return noCompression;
        });

      const prompt = runGuardPrompt();
      await compressionStartedPromise;
      expect(claimCount).toBe(1);
      queuedAfterClaim = true;
      releaseCompression();
      await prompt;

      expect(claimCount).toBe(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(true);
    });

    it('selects a drained image model before Guard claims and skips primary-model compression', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockConfig.getEffectiveInputModalities = vi.fn().mockReturnValue({});
      const events: string[] = [];
      mockConfig.getDefaultVisionBridgeModel = vi
        .fn()
        .mockImplementation(() => {
          events.push('vision');
          return {
            id: 'vision-agent',
            baseUrl: 'https://vision.example.com/v1',
            agentCapable: true,
          };
        });
      const noCompression = {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      };
      mockLlmClient.tryCompressChat.mockImplementation(async () => {
        events.push('compression');
        return noCompression;
      });
      let drainCount = 0;
      mockGuardBridge(
        async () => {
          drainCount++;
          if (drainCount === 1) {
            events.push('image-drain');
            return {
              items: [
                {
                  content: [
                    { type: 'text', text: 'inspect this image too' },
                    {
                      type: 'image',
                      mimeType: 'image/png',
                      data: 'iVBORw0KGgo=',
                    },
                  ],
                  displayText: 'inspect this image too',
                },
              ],
              hasQueuedPrompt: false,
            };
          }
          return { messages: [], hasQueuedPrompt: false };
        },
        async () => {
          events.push('claim');
          return { claimed: true, hasQueuedPrompt: false };
        },
      );

      await runGuardPrompt();

      const imageDrainIndex = events.indexOf('image-drain');
      const visionAfterDrainIndex = events.findIndex(
        (event, index) => event === 'vision' && index > imageDrainIndex,
      );
      expect(visionAfterDrainIndex).toBeGreaterThan(imageDrainIndex);
      expect(visionAfterDrainIndex).toBeLessThan(events.indexOf('claim'));
      expect(events.filter((event) => event === 'compression')).toHaveLength(1);
      expect(events.indexOf('compression')).toBeLessThan(imageDrainIndex);
      expect(mockLlmClient.tryCompressChat).toHaveBeenCalledOnce();
      for (const call of vi
        .mocked(mockChat.sendMessageStream)
        .mock.calls.slice(1)) {
        expect(call[0]).toBe('vision-agent\0https://vision.example.com/v1\0');
      }
    });

    it('does not persist an unsent Guard prompt when compression is cancelled', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let compressionStarted!: () => void;
      const compressionStartedPromise = new Promise<void>((resolve) => {
        compressionStarted = resolve;
      });
      let releaseCompression!: () => void;
      const compressionGate = new Promise<void>((resolve) => {
        releaseCompression = resolve;
      });
      const noCompression = {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      };
      mockLlmClient.tryCompressChat
        .mockResolvedValueOnce(noCompression)
        .mockResolvedValueOnce(noCompression)
        .mockImplementationOnce(async () => {
          compressionStarted();
          await compressionGate;
          return noCompression;
        });

      const prompt = runGuardPrompt();
      await compressionStartedPromise;
      const addHistory = vi.mocked(mockChat.addHistory);
      addHistory.mockClear();
      await session.cancelPendingPrompt();
      releaseCompression();
      await prompt;

      const preservedText = addHistory.mock.calls
        .flatMap(([content]) => content.parts ?? [])
        .flatMap((part) => ('text' in part && part.text ? [part.text] : []))
        .join('\n');
      expect(preservedText).not.toContain('[Todo Stop Guard]');
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it.each([
      core.CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
      core.CompressionStatus.COMPRESSION_FAILED_API_ERROR,
    ])(
      'does not count a failed Guard compression status %s or block later automatic work',
      async (compressionStatus) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        const noCompression = {
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        };
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce(noCompression)
          .mockResolvedValueOnce(noCompression)
          .mockResolvedValueOnce({
            originalTokenCount: 120,
            newTokenCount: 120,
            compressionStatus,
          })
          .mockResolvedValue(noCompression);

        await runGuardPrompt();

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.some(
              ([params]) =>
                params.update.sessionUpdate === 'agent_message_chunk' &&
                params.update._meta?.['source'] === 'todo_stop_guard',
            ),
        ).toBe(false);

        const callback =
          mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
            -1,
          )?.[0] as (
            displayText: string,
            modelText: string,
            meta: { agentId: string; status: string },
          ) => void;
        callback('independent background done', '<task-notification />', {
          agentId: 'after-guard-compression-failure',
          status: 'completed',
        });

        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        });
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.some(
              ([params]) =>
                params.update.sessionUpdate === 'agent_message_chunk' &&
                params.update._meta?.['source'] === 'todo_stop_guard',
            ),
        ).toBe(false);
      },
    );

    it('keeps external Stop hook continuation when Guard compression throws', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      const noCompression = {
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      };
      mockLlmClient.tryCompressChat
        .mockResolvedValueOnce(noCompression)
        .mockResolvedValueOnce(noCompression)
        .mockRejectedValueOnce(new Error('compression unavailable'))
        .mockResolvedValue(noCompression);
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: 'external hook still continues',
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      const externalOnly = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(externalOnly.message).join('\n')).toContain(
        'external hook still continues',
      );
      expect(textParts(externalOnly.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it.each([
      {
        label: 'mid-turn input',
        priorityResponse: {
          messages: ['user input queued during failed compression'],
          hasQueuedPrompt: false,
        },
        expectedCalls: 5,
        expectedGuardAttempts: [1, 2, 2],
      },
      {
        label: 'a complete FIFO prompt',
        priorityResponse: { messages: [], hasQueuedPrompt: true },
        expectedCalls: 2,
        expectedGuardAttempts: [],
      },
    ])(
      'keeps $label ahead of an external hook when Guard compression fails',
      async ({ priorityResponse, expectedCalls, expectedGuardAttempts }) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        const noCompression = {
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        };
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce(noCompression)
          .mockResolvedValueOnce(noCompression)
          .mockResolvedValueOnce({
            originalTokenCount: 120,
            newTokenCount: 120,
            compressionStatus:
              core.CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          })
          .mockResolvedValue(noCompression);
        mockGuardDrainResponses(
          { messages: [], hasQueuedPrompt: false },
          { messages: [], hasQueuedPrompt: false },
          { messages: [], hasQueuedPrompt: false },
          priorityResponse,
          { messages: [], hasQueuedPrompt: false },
        );
        let stopCalls = 0;
        const messageBus = {
          request: vi.fn().mockImplementation(async (request) => {
            if (request.eventName !== 'Stop') {
              return { success: true, output: {} };
            }
            stopCalls++;
            return stopCalls === 1
              ? {
                  success: true,
                  output: {
                    decision: 'block',
                    reason: 'external hook must yield',
                  },
                }
              : { success: true, output: {} };
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((name: string) => name === 'Stop');

        await runGuardPrompt();

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(expectedCalls);
        if (priorityResponse.messages.length > 0) {
          const userCall = vi.mocked(mockChat.sendMessageStream).mock
            .calls[2]?.[1] as { message: Part[] };
          const text = textParts(userCall.message).join('\n');
          expect(text).toContain('user input queued during failed compression');
          expect(text).not.toContain('external hook must yield');
          expect(text).not.toContain('[Todo Stop Guard]');
        }
        const guardAttempts = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update)
          .filter(
            (update) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update._meta?.['source'] === 'todo_stop_guard',
          )
          .map((update) => update._meta?.['attempt']);
        expect(guardAttempts).toEqual(expectedGuardAttempts);
      },
    );

    it('counts every Guard-attributable tool follow-up as a model call', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readExecute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: readExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-guard-tools',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'guard-read-1',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
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
                functionCalls: [
                  {
                    id: 'guard-read-2',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]),
        );

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      expect(readExecute).toHaveBeenCalledTimes(2);
      const secondGuardCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(secondGuardCall.message).join('\n')).toContain(
        'This is the final automatic continuation.',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it.each([
      [
        'preserves a successful Guard tool response before history advances',
        false,
        false,
      ],
      [
        'does not duplicate a successful Guard tool response after history advances',
        true,
        false,
      ],
      [
        'does not duplicate a successful Guard tool response after compression replaces the chat',
        true,
        true,
      ],
    ])(
      '%s when stream creation fails',
      async (_label, historyAlreadyAdvanced, replaceChatAfterCompression) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
        const readExecute = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        const readTool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            execute: readExecute,
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
          }),
        };
        mockToolRegistry.getTool.mockImplementation((name: string) =>
          name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
        );
        let drainCount = 0;
        mockGuardBridge(async () => ({
          messages:
            ++drainCount === 4
              ? ['user direction before the failed follow-up']
              : [],
          hasQueuedPrompt: false,
        }));
        let userContentPushCount = 0;
        (
          mockChat as unknown as {
            getUserContentPushCount: () => number;
          }
        ).getUserContentPushCount = vi.fn(() => userContentPushCount);
        const replacementChat = Object.create(mockChat) as LlmChat;
        const replacementAddHistory = vi.fn();
        replacementChat.addHistory = replacementAddHistory;
        replacementChat.getUserContentPushCount = vi.fn(
          () => userContentPushCount,
        );
        replacementChat.sendMessageStream = vi.fn(async () => {
          userContentPushCount++;
          throw new Error('Guard follow-up stream creation failed');
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
                      id: 'todo-before-preservation',
                      name: core.ToolNames.TODO_WRITE,
                      args: { todos: pendingTodos },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'guard-read-before-send-failure',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockImplementationOnce(
            replaceChatAfterCompression
              ? async () => createEmptyStream()
              : async () => {
                  if (historyAlreadyAdvanced) userContentPushCount++;
                  throw new Error('Guard follow-up stream creation failed');
                },
          );
        if (replaceChatAfterCompression) {
          mockLlmClient.tryCompressChat.mockImplementation(async () => {
            if (vi.mocked(mockChat.sendMessageStream).mock.calls.length === 3) {
              mockLlmClient.getChat.mockReturnValue(replacementChat);
            }
            return {
              originalTokenCount: 0,
              newTokenCount: 0,
              compressionStatus: core.CompressionStatus.NOOP,
            };
          });
        }

        await expect(runGuardPrompt()).rejects.toThrow(
          'Guard follow-up stream creation failed',
        );

        const preservedMessages = [
          ...vi
            .mocked(mockChat.addHistory)
            .mock.calls.map(([content]) => content),
          ...replacementAddHistory.mock.calls.map(
            ([content]) => content as Content,
          ),
        ].filter((content) =>
          content.parts?.some(
            (part) =>
              'functionResponse' in part &&
              part.functionResponse?.id === 'guard-read-before-send-failure',
          ),
        );
        expect(preservedMessages).toHaveLength(historyAlreadyAdvanced ? 0 : 1);
        const preservedText = preservedMessages
          .flatMap((content) => content.parts ?? [])
          .flatMap((part) => ('text' in part && part.text ? [part.text] : []))
          .join('\n');
        expect(preservedText).not.toContain('[Todo Stop Guard]');
        if (!historyAlreadyAdvanced) {
          expect(preservedText).toContain(
            'user direction before the failed follow-up',
          );
        }
      },
    );

    it('closes Guard tools with the remaining attempt after Todo completion', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const completedTodos = pendingTodos.map((todo) => ({
        ...todo,
        status: 'completed' as const,
      }));
      execute
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        })
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(completedTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: completedTodos,
            changes: {},
          },
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
                    id: 'todo-before-guard-completion',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-completed-by-guard',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: completedTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await runGuardPrompt();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const toolClosure = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as {
        message: Part[];
      };
      expect(
        toolClosure.message.some(
          (part) =>
            'functionResponse' in part &&
            part.functionResponse?.id === 'todo-completed-by-guard',
        ),
      ).toBe(true);
      expect(textParts(toolClosure.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
      const guardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardUpdates.map((update) => update._meta?.['attempt'])).toEqual([
        1, 2,
      ]);
      expect(guardUpdates.at(-1)?._meta?.['unfinishedCount']).toBe(0);
    });

    it('drains background input when completed-Todo tool closure fails', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const completedTodos = pendingTodos.map((todo) => ({
        ...todo,
        status: 'completed' as const,
      }));
      execute
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        })
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(completedTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: completedTodos,
            changes: {},
          },
        });
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-failed-closure',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-completed-before-failed-closure',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: completedTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(
          createFailingStream('completed Todo closure failed', () => {
            callback('background done', '<after-failed-tool-closure />', {
              agentId: 'after-failed-tool-closure',
              status: 'completed',
            });
          }),
        )
        .mockResolvedValue(createEmptyStream());

      await expect(runGuardPrompt()).rejects.toThrow(
        'completed Todo closure failed',
      );
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      });
      const notificationCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[4]?.[1] as { message: Part[] };
      expect(textParts(notificationCall.message).join('\n')).toContain(
        '<after-failed-tool-closure />',
      );
    });

    it('lets mid-turn input sponsor the tool response after Todo completion', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const completedTodos = pendingTodos.map((todo) => ({
        ...todo,
        status: 'completed' as const,
      }));
      execute.mockResolvedValueOnce({
        llmContent: JSON.stringify(pendingTodos),
        returnDisplay: {
          type: 'todo_list',
          todos: pendingTodos,
          changes: {},
        },
      });
      execute.mockResolvedValueOnce({
        llmContent: JSON.stringify(completedTodos),
        returnDisplay: {
          type: 'todo_list',
          todos: completedTodos,
          changes: {},
        },
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
                    id: 'todo-before-completed-midturn',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-completed-before-midturn',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: completedTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());
      mockGuardBridge(async () => ({
        messages:
          vi.mocked(mockChat.sendMessageStream).mock.calls.length === 3
            ? ['user direction after completion']
            : [],
        hasQueuedPrompt: false,
      }));

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const userContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(userContinuation.message).join('\n')).toContain(
        'user direction after completion',
      );
      expect(textParts(userContinuation.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1]);
    });

    it('does not close completed Todo tools after PostToolUse stops the chain', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const completedTodos = pendingTodos.map((todo) => ({
        ...todo,
        status: 'completed' as const,
      }));
      execute
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        })
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(completedTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: completedTodos,
            changes: {},
          },
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
                    id: 'todo-before-post-hook-stop',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-completed-before-post-hook-stop',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: completedTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      let postToolUseCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'PostToolUse') {
            return { success: true, output: {} };
          }
          postToolUseCalls++;
          return postToolUseCalls === 2
            ? {
                success: true,
                output: {
                  continue: false,
                  reason: 'stop after completed Todo',
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'PostToolUse');

      await runGuardPrompt();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(postToolUseCalls).toBe(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1]);
    });

    it('lets a queued prompt preempt completed Todo tool closure', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const completedTodos = pendingTodos.map((todo) => ({
        ...todo,
        status: 'completed' as const,
      }));
      execute
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        })
        .mockResolvedValueOnce({
          llmContent: JSON.stringify(completedTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: completedTodos,
            changes: {},
          },
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
                    id: 'todo-before-queued-tool-closure',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-completed-before-queued-tool-closure',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: completedTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt:
          vi.mocked(mockChat.sendMessageStream).mock.calls.length === 3,
      }));

      await runGuardPrompt();

      expect(execute).toHaveBeenCalledTimes(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);
    });

    it('keeps tool responses when mid-turn input supersedes a nested Guard call', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          }),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['user input before the nested Guard send'],
          hasQueuedPrompt: false,
        },
        { messages: [], hasQueuedPrompt: false },
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-nested-midturn',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'read-before-nested-midturn',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();

      const nestedUserCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(
        nestedUserCall.message.some((part) => 'functionResponse' in part),
      ).toBe(true);
      expect(textParts(nestedUserCall.message).join('\n')).toContain(
        'user input before the nested Guard send',
      );
      expect(textParts(nestedUserCall.message).join('\n')).not.toContain(
        'This is the final automatic continuation.',
      );
    });

    it('keeps the external Stop hook count when nested Guard work yields to the user', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          }),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['user input before the nested combined send'],
          hasQueuedPrompt: false,
        },
        { messages: [], hasQueuedPrompt: false },
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-nested-combined-midturn',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'read-before-nested-combined-midturn',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls <= 2
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: `hook continuation ${stopCalls}`,
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(6);
      const stopHookLoops = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update._meta?.['stopHookLoop'])
        .filter((meta) => meta !== undefined);
      expect(stopHookLoops).toContainEqual(
        expect.objectContaining({
          iterationCount: 2,
          reasons: ['hook continuation 1', 'hook continuation 2'],
        }),
      );
    });

    it('does not let mid-turn input revive a PostToolUse-stopped guard', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({
        messages: ['new direction after the stopped tool'],
        hasQueuedPrompt: false,
      }));
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'PostToolUse'
              ? { continue: false, reason: 'stop after Todo' }
              : { continue: true },
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'PostToolUse');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      const postToolContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[1]?.[1] as { message: Part[] };
      expect(textParts(postToolContinuation.message).join('\n')).toContain(
        'new direction after the stopped tool',
      );
      expect(messageBus.request).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'PostToolUse' }),
        expect.anything(),
      );
    });

    it('does not revive a deferred chain after entering and leaving plan mode', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'plan-boundary-agent',
            description: 'plan-boundary-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'default',
      });

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'plan-boundary-agent',
          description: 'plan-boundary-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'plan-boundary-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('yields to a queued complete prompt and preserves simultaneously drained input', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'model', parts: [{ text: 'unfinished' }] },
      ]);
      vi.mocked(core.generatePromptSuggestion).mockClear();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['context drained beside the queued prompt'],
          hasQueuedPrompt: true,
        },
      );

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
      expect(core.generatePromptSuggestion).not.toHaveBeenCalled();
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            text: '\n[User message received during tool execution]: context drained beside the queued prompt',
          },
        ],
      });
    });

    it('releases FIFO priority when the queued prompt is a trusted retry', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt: true,
      }));

      await runGuardPrompt();
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt: false,
      }));
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'trusted queued retry' }],
        _meta: { 'qwen.daemon.retry': true },
      } as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update._meta?.['attempt'])
          .filter((attempt) => attempt !== undefined),
      ).toEqual([1, 2, 2]);
    });

    it('keeps a queued prompt ahead of related automatic input', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      execute.mockImplementation(async () => {
        callback('background done', '<related-task-notification />', {
          agentId: 'related-before-queued-prompt',
          status: 'completed',
        });
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt: true,
      }));

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      const queuedPrompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'queued user prompt wins' }],
      });
      await queuedPrompt;
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });
      const firstAfterYield = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      const secondAfterYield = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(firstAfterYield.message).join('\n')).toContain(
        'queued user prompt wins',
      );
      expect(textParts(secondAfterYield.message).join('\n')).toContain(
        '<related-task-notification />',
      );
    });

    it('retains observed FIFO priority while preserving simultaneous mid-turn input', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      execute
        .mockImplementationOnce(async () => {
          callback('background done', '<related-after-mid-turn />', {
            agentId: 'related-after-mid-turn',
            status: 'completed',
          });
          return {
            llmContent: JSON.stringify(pendingTodos),
            returnDisplay: {
              type: 'todo_list',
              todos: pendingTodos,
              changes: {},
            },
          };
        })
        .mockResolvedValueOnce({
          llmContent: 'completed',
          returnDisplay: {
            type: 'todo_list',
            todos: [
              {
                id: 'task-1',
                content: 'finish task',
                status: 'completed',
              },
            ],
            changes: {},
          },
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
                    id: 'pending-before-combined-priority',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'complete-after-mid-turn',
                    name: core.ToolNames.TODO_WRITE,
                    args: {
                      todos: [
                        {
                          id: 'task-1',
                          content: 'finish task',
                          status: 'completed',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['mid-turn direction before queued prompt'],
          hasQueuedPrompt: true,
        },
        { messages: [], hasQueuedPrompt: false },
      );
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? { decision: 'block', reason: 'must not run before FIFO' }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        messageBus.request.mock.calls.some(
          ([request]) => request.eventName === 'Stop',
        ),
      ).toBe(false);
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            text: '\n[User message received during tool execution]: mid-turn direction before queued prompt',
          },
        ],
      });
      mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(false);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'observed FIFO prompt' }],
      });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      });
      const fifoCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as {
        message: Part[];
      };
      const notificationCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[4]?.[1] as { message: Part[] };
      expect(textParts(fifoCall.message).join('\n')).toContain(
        'observed FIFO prompt',
      );
      expect(textParts(notificationCall.message).join('\n')).toContain(
        '<related-after-mid-turn />',
      );
    });

    it('terminates a yielded guard when the queued prompt is cancelled', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt: true,
      }));

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);

      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-after-queued-prompt-cancel',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      callback('background done', '<task-notification />', {
        agentId: 'after-queued-prompt-cancel',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(false);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('ignores a late release from a previous queued-prompt owner', () => {
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        todoStopGuardQueuedPromptOwnerPromptId?: string;
      };
      internals.todoStopGuardQueuedPromptPriority = true;
      internals.todoStopGuardQueuedPromptOwnerPromptId = 'new-owner';

      expect(session.releaseTodoStopGuardQueuedPromptWait('old-owner')).toBe(
        false,
      );
      expect(internals.todoStopGuardQueuedPromptPriority).toBe(true);
      expect(internals.todoStopGuardQueuedPromptOwnerPromptId).toBe(
        'new-owner',
      );
      expect(session.releaseTodoStopGuardQueuedPromptWait('new-owner')).toBe(
        true,
      );
    });

    it('drains old deferred work when the FIFO prompt errors before arming', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({
        messages: [],
        hasQueuedPrompt: true,
      }));

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<deferred-before-fifo-error />', {
        agentId: 'deferred-before-fifo-error',
        status: 'completed',
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createFailingStream('FIFO prompt failed'))
        .mockResolvedValue(createEmptyStream());

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'queued FIFO work' }],
        }),
      ).rejects.toThrow('FIFO prompt failed');
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      const notificationCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[1]?.[1] as { message: Part[] };
      expect(textParts(notificationCall.message).join('\n')).toContain(
        '<deferred-before-fifo-error />',
      );
    });

    it('drains deferred work after FIFO cancellation without running simultaneous mid-turn input first', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-midturn-fifo-cancel',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValue(createEmptyStream());
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['mid-turn before queued prompt cancellation'],
          hasQueuedPrompt: true,
        },
        { messages: [], hasQueuedPrompt: false },
      );

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            text: '\n[User message received during tool execution]: mid-turn before queued prompt cancellation',
          },
        ],
      });
      callback('background done', '<after-midturn-fifo-cancel />', {
        agentId: 'after-midturn-fifo-cancel',
        status: 'completed',
      });
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });
      const notificationCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(notificationCall.message).join('\n')).toContain(
        '<after-midturn-fifo-cancel />',
      );
    });

    it('does not re-arm after the matching queued owner is released', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: true },
        { messages: [], hasQueuedPrompt: false },
      );

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(true);
      expect(
        session.releaseTodoStopGuardQueuedPromptWait(lastGuardPromptId),
      ).toBe(false);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'after-racing-queue-cancel',
        status: 'completed',
      });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('runs mid-turn user input first and resets the continuation budget', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['new user direction'],
          hasQueuedPrompt: false,
        },
        { messages: [], hasQueuedPrompt: false },
      );

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(6);
      const midTurnCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(textParts(midTurnCall.message).join('\n')).toContain(
        'new user direction',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 1, 2, 2]);
    });

    it('ignores background tasks that predate the work chain', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
    });

    it('classifies monitor notifications by their owner agent lineage', () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'baseline-agent',
          description: 'baseline-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      mockMonitorRegistry.getAll.mockReturnValue([
        {
          id: 'baseline-monitor',
          description: 'baseline-monitor',
          status: 'running',
        },
      ]);
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: Array<{
          taskId: string;
          continuesTodoStopGuardWorkChain: boolean;
        }>;
        relatedAgentIds: Set<string>;
      };
      internals.notificationProcessing = true;
      internals.relatedAgentIds.add('continued-agent');
      const callback =
        mockMonitorRegistry.setNotificationCallback.mock.calls.at(-1)?.[0] as (
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            ownerAgentId?: string;
            status: string;
          },
        ) => void;

      callback('baseline owner result', '<baseline-owner />', {
        monitorId: 'new-monitor',
        ownerAgentId: 'baseline-agent',
        status: 'completed',
      });
      callback('continued owner result', '<continued-owner />', {
        monitorId: 'baseline-monitor',
        ownerAgentId: 'continued-agent',
        status: 'completed',
      });

      expect(internals.notificationQueue).toEqual([
        expect.objectContaining({
          taskId: 'new-monitor',
          continuesTodoStopGuardWorkChain: false,
        }),
        expect.objectContaining({
          taskId: 'baseline-monitor',
          continuesTodoStopGuardWorkChain: true,
        }),
      ]);
      internals.notificationProcessing = false;
    });

    it('classifies workflow notifications from the captured baseline', () => {
      const baselineWorkflow = {
        runId: 'baseline-workflow',
        status: 'running',
      };
      let currentWorkflow: typeof baselineWorkflow | undefined =
        baselineWorkflow;
      mockWorkflowRunRegistry.list.mockImplementation(() =>
        currentWorkflow ? [currentWorkflow] : [],
      );
      mockWorkflowRunRegistry.get.mockImplementation((runId: string) =>
        currentWorkflow?.runId === runId ? currentWorkflow : undefined,
      );
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: Array<{
          taskId: string;
          continuesTodoStopGuardWorkChain: boolean;
        }>;
      };
      internals.notificationProcessing = true;
      const callback =
        mockWorkflowRunRegistry.setCompletionCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: {
            runId: string;
            status: 'completed';
            todoWorkChainId?: string;
          },
        ) => void;

      callback('baseline result', '<baseline-workflow />', {
        runId: 'baseline-workflow',
        status: 'completed',
        todoWorkChainId: 'stale-chain',
      });
      currentWorkflow = {
        runId: 'baseline-workflow',
        status: 'running',
      };
      callback('retry result', '<retry-workflow />', {
        runId: 'baseline-workflow',
        status: 'completed',
      });
      currentWorkflow = undefined;
      callback('new result', '<new-workflow />', {
        runId: 'new-workflow',
        status: 'completed',
      });

      expect(internals.notificationQueue).toEqual([
        expect.objectContaining({
          taskId: 'baseline-workflow',
          continuesTodoStopGuardWorkChain: false,
        }),
        expect.objectContaining({
          taskId: 'baseline-workflow',
          continuesTodoStopGuardWorkChain: true,
        }),
        expect.objectContaining({
          taskId: 'new-workflow',
          continuesTodoStopGuardWorkChain: true,
        }),
      ]);
      internals.notificationProcessing = false;
    });

    it('commits and rolls back existing-agent lineage around send_message execution', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'continued-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: false,
        },
        {
          id: 'failed-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard({ disableHooks: true });
      const internals = session as unknown as {
        relatedAgentIds: Set<string>;
        runToolCalls: (
          signal: AbortSignal,
          promptId: string,
          calls: FunctionCall[],
        ) => Promise<unknown>;
      };
      const execute = vi.fn().mockImplementation(async () => ({
        llmContent: 'continued',
        returnDisplay: 'continued',
      }));
      mockToolRegistry.getTool.mockReturnValue({
        constructor: { name: 'SendMessageTool' },
        name: core.ToolNames.SEND_MESSAGE,
        kind: core.Kind.Think,
        displayName: 'SendMessage',
        description: 'Continue an agent',
        build: vi.fn().mockImplementation((args) => ({
          params: args,
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Continue an agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        })),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      await internals.runToolCalls(
        new AbortController().signal,
        'continue-existing-agent',
        [
          {
            id: 'continue-existing-agent',
            name: core.ToolNames.SEND_MESSAGE,
            args: { task_id: 'continued-agent', message: 'continue' },
          },
        ],
      );
      expect(internals.relatedAgentIds.has('continued-agent')).toBe(true);

      execute.mockResolvedValueOnce({
        llmContent: 'failed',
        returnDisplay: 'failed',
        error: { message: 'agent continuation failed' },
      });
      await internals.runToolCalls(
        new AbortController().signal,
        'fail-existing-agent',
        [
          {
            id: 'fail-existing-agent',
            name: core.ToolNames.SEND_MESSAGE,
            args: { task_id: 'failed-agent', message: 'continue' },
          },
        ],
      );
      expect(internals.relatedAgentIds.has('failed-agent')).toBe(false);
      expect(internals.relatedAgentIds.has('continued-agent')).toBe(true);
    });

    it('keeps a successful agent continuation related when a concurrent continuation fails', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'racing-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard({ disableHooks: true });
      const internals = session as unknown as {
        relatedAgentIds: Set<string>;
        provisionalRelatedAgentCounts: Map<string, number>;
        runToolCalls: (
          signal: AbortSignal,
          promptId: string,
          calls: FunctionCall[],
        ) => Promise<unknown>;
      };
      let releaseFailure!: () => void;
      const failureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      mockToolRegistry.getTool.mockReturnValue({
        constructor: { name: 'SendMessageTool' },
        name: core.ToolNames.SEND_MESSAGE,
        kind: core.Kind.Think,
        displayName: 'SendMessage',
        description: 'Continue an agent',
        build: vi.fn().mockImplementation((args) => ({
          params: args,
          execute: vi.fn().mockImplementation(async () => {
            if (args.message === 'fail later') {
              await failureGate;
              return {
                llmContent: 'failed',
                returnDisplay: 'failed',
                error: { message: 'agent continuation failed' },
              };
            }
            return {
              llmContent: 'continued',
              returnDisplay: 'continued',
            };
          }),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Continue an agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        })),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      });

      const failing = internals.runToolCalls(
        new AbortController().signal,
        'failing-continuation',
        [
          {
            id: 'failing-continuation',
            name: core.ToolNames.SEND_MESSAGE,
            args: {
              task_id: 'racing-agent',
              message: 'fail later',
            },
          },
        ],
      );
      await vi.waitFor(() => {
        expect(
          internals.provisionalRelatedAgentCounts.get('racing-agent'),
        ).toBe(1);
      });

      await internals.runToolCalls(
        new AbortController().signal,
        'successful-continuation',
        [
          {
            id: 'successful-continuation',
            name: core.ToolNames.SEND_MESSAGE,
            args: {
              task_id: 'racing-agent',
              message: 'succeed now',
            },
          },
        ],
      );
      expect(internals.relatedAgentIds.has('racing-agent')).toBe(true);

      releaseFailure();
      await failing;

      expect(internals.relatedAgentIds.has('racing-agent')).toBe(true);
      expect(internals.provisionalRelatedAgentCounts.has('racing-agent')).toBe(
        false,
      );
    });

    it.each([
      { label: 'a newer prompt supersedes the turn', cancel: false },
      { label: 'the user cancels the turn', cancel: true },
    ])(
      'preserves combined continuation tool responses when $label',
      async ({ cancel }) => {
        rebuildSessionWithGuard();
        const execute = installPendingTodoTool();
        const toolResult = {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
        let secondToolStarted!: () => void;
        const secondToolStart = new Promise<void>((resolve) => {
          secondToolStarted = resolve;
        });
        let releaseSecondTool!: () => void;
        const secondToolGate = new Promise<void>((resolve) => {
          releaseSecondTool = resolve;
        });
        let toolCallCount = 0;
        execute.mockImplementation(async () => {
          if (++toolCallCount === 2) {
            secondToolStarted();
            await secondToolGate;
          }
          return toolResult;
        });
        const toolCallStream = (id: string) =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id,
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(toolCallStream('todo-before-supersession'))
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            toolCallStream('combined-tool-before-supersession'),
          )
          .mockResolvedValue(createEmptyStream());
        let stopCalls = 0;
        const messageBus = {
          request: vi.fn().mockImplementation(async (request) => {
            if (request.eventName !== 'Stop') {
              return { success: true, output: {} };
            }
            return ++stopCalls === 1
              ? {
                  success: true,
                  output: {
                    decision: 'block',
                    reason: 'external continuation before supersession',
                  },
                }
              : { success: true, output: {} };
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((name: string) => name === 'Stop');

        const firstPrompt = runGuardPrompt();
        await secondToolStart;
        let secondPrompt: ReturnType<typeof session.prompt> | undefined;
        if (cancel) {
          await session.cancelPendingPrompt();
        } else {
          const internals = session as unknown as {
            pendingPrompt: AbortController | null;
          };
          const firstOwner = internals.pendingPrompt;
          secondPrompt = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'superseding prompt' }],
          });
          await vi.waitFor(() => {
            expect(internals.pendingPrompt).not.toBe(firstOwner);
          });
        }
        releaseSecondTool();

        const firstResult = await firstPrompt;
        await secondPrompt;

        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'combined-tool-before-supersession',
              }),
            }),
          ],
        });
        expect(firstResult).toMatchObject({ stopReason: 'cancelled' });
      },
    );

    it('preserves newer prompt state and includes tasks created while the superseded prompt unwinds', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const internals = session as unknown as {
        todoStopGuardDrainAutomaticQueuesWhenIdle: boolean;
      };
      let enterWait!: () => void;
      const waitStarted = new Promise<void>((resolve) => {
        enterWait = resolve;
      });
      let releaseWait!: () => void;
      const waitGate = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      let waitCalls = 0;
      session.messageRewriter = {
        interceptUpdate: vi.fn().mockResolvedValue(undefined),
        waitForPendingRewrites: vi.fn(async () => {
          if (++waitCalls !== 1) return;
          enterWait();
          await waitGate;
        }),
      } as unknown as NonNullable<Session['messageRewriter']>;
      let enterSecondSend!: () => void;
      const secondSendStarted = new Promise<void>((resolve) => {
        enterSecondSend = resolve;
      });
      let releaseSecondSend!: () => void;
      const secondSendGate = new Promise<void>((resolve) => {
        releaseSecondSend = resolve;
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockImplementationOnce(async () => {
          enterSecondSend();
          await secondSendGate;
          return createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'second-prompt-todo',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]);
        })
        .mockResolvedValue(createEmptyStream());

      const firstPrompt = runGuardPrompt();
      await waitStarted;
      const secondPrompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'new work chain' }],
      });
      internals.todoStopGuardDrainAutomaticQueuesWhenIdle = true;
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-unwind-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      releaseWait();
      await secondSendStarted;

      expect(internals.todoStopGuardDrainAutomaticQueuesWhenIdle).toBe(true);
      releaseSecondSend();

      const [firstResult] = await Promise.all([firstPrompt, secondPrompt]);
      expect(firstResult).toEqual({ stopReason: 'cancelled' });
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
    });

    it('reclassifies queued notifications when a new work chain starts', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([]);
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: Array<{
          taskId: string;
          continuesTodoStopGuardWorkChain: boolean;
        }>;
      };
      internals.notificationProcessing = true;
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'previous-chain-agent',
          description: 'previous-chain-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('previous result', '<previous-chain-result />', {
        agentId: 'previous-chain-agent',
        status: 'completed',
      });
      expect(internals.notificationQueue).toEqual([
        expect.objectContaining({
          taskId: 'previous-chain-agent',
          continuesTodoStopGuardWorkChain: true,
        }),
      ]);

      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      await runGuardPrompt();

      expect(internals.notificationQueue).toEqual([
        expect.objectContaining({
          taskId: 'previous-chain-agent',
          continuesTodoStopGuardWorkChain: false,
        }),
      ]);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      internals.notificationProcessing = false;
    });

    it('defers while a background task created by the work chain is running', async () => {
      rebuildSessionWithGuard();
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'model', parts: [{ text: 'waiting for background work' }] },
      ]);
      vi.mocked(core.generatePromptSuggestion).mockClear();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'new-agent',
            description: 'new-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(core.generatePromptSuggestion).not.toHaveBeenCalled();
    });

    it('defers while a background shell created by the work chain is running', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundShellRegistry.getAll.mockReturnValue([
          { id: 'new-shell', status: 'running' },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('defers while a monitor created by the work chain is running', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockMonitorRegistry.getAll.mockReturnValue([
          { id: 'new-monitor', status: 'running' },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('does not resume an old Guard after the working directory changes', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'cwd-agent',
            description: 'cwd-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      session.clearTodoStopGuardTrust();
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'cwd-agent',
          description: 'cwd-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<cwd-task-notification />', {
        agentId: 'cwd-agent',
        status: 'completed',
      });

      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: unknown[];
      };
      await vi.waitFor(() => {
        expect(internals.notificationProcessing).toBe(false);
        expect(internals.notificationQueue).toHaveLength(0);
      });
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('defers while a background task created by the work chain is paused', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'paused-agent',
            isBackgrounded: true,
            status: 'paused',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('continues the same guard when its background task reports completion', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'new-agent',
            description: 'new-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'new-agent',
          description: 'new-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'new-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });
    });

    it('does not let an old notification displace a chain waiting on its own task', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'old-agent',
            description: 'old-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
          {
            id: 'new-agent',
            description: 'new-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('old background done', '<old-task-notification />', {
        agentId: 'old-agent',
        status: 'completed',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
        {
          id: 'new-agent',
          description: 'new-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      callback('new background done', '<new-task-notification />', {
        agentId: 'new-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(6);
      });
      const firstAutomaticSend = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(firstAutomaticSend.message).join('\n')).toContain(
        '<new-task-notification />',
      );
      expect(textParts(firstAutomaticSend.message).join('\n')).not.toContain(
        '<old-task-notification />',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it('protects a related notification from unrelated queue overflow', async () => {
      const oldAgents = Array.from({ length: 20 }, (_value, index) => ({
        id: `old-agent-${index}`,
        description: `old-agent-${index}`,
        isBackgrounded: true,
        status: 'running',
        notified: false,
      }));
      mockBackgroundTaskRegistry.getAll.mockReturnValue(oldAgents);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          ...oldAgents,
          {
            id: 'new-agent',
            description: 'new-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: Array<{ taskId: string }>;
      };
      internals.notificationProcessing = true;
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('new result', '<new-result />', {
        agentId: 'new-agent',
        status: 'completed',
      });
      for (const oldAgent of oldAgents) {
        callback('old result', '<old-result />', {
          agentId: oldAgent.id,
          status: 'completed',
        });
      }

      expect(internals.notificationQueue).toHaveLength(20);
      expect(
        internals.notificationQueue.some((item) => item.taskId === 'new-agent'),
      ).toBe(true);
      internals.notificationProcessing = false;
    });

    it('preserves queued related notifications when the queue is full', async () => {
      const relatedAgents = Array.from({ length: 21 }, (_value, index) => ({
        id: `related-agent-${index}`,
        description: `related-agent-${index}`,
        isBackgrounded: true,
        status: 'running',
        notified: false,
      }));
      mockBackgroundTaskRegistry.getAll.mockReturnValue([]);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue(relatedAgents);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      const internals = session as unknown as {
        notificationProcessing: boolean;
        notificationQueue: Array<{ taskId: string }>;
        droppedNotifications: { count: number };
      };
      internals.notificationProcessing = true;
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      for (let index = 0; index < 20; index++) {
        callback('related result', '<related-result />', {
          agentId: `related-agent-${index}`,
          status: 'completed',
        });
      }
      debugLoggerWarnSpy.mockClear();
      callback('overflow result', '<overflow-result />', {
        agentId: 'related-agent-20',
        status: 'completed',
      });

      expect(internals.notificationQueue).toHaveLength(20);
      expect(internals.notificationQueue[0]?.taskId).toBe('related-agent-0');
      expect(
        internals.notificationQueue.some(
          (item) => item.taskId === 'related-agent-20',
        ),
      ).toBe(false);
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        'Notification queue overflow: dropping related task=related-agent-20 kind=agent because all queued items are related',
      );
      expect(internals.droppedNotifications.count).toBe(1);
      internals.notificationProcessing = false;
    });

    it('protects a related notification while FIFO priority outlives guard trust', () => {
      const oldAgents = Array.from({ length: 20 }, (_value, index) => ({
        id: `fifo-old-agent-${index}`,
        description: `fifo-old-agent-${index}`,
        isBackgrounded: true,
        status: 'running',
        notified: false,
      }));
      mockBackgroundTaskRegistry.getAll.mockReturnValue(oldAgents);
      rebuildSessionWithGuard();
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        ...oldAgents,
        {
          id: 'fifo-related-agent',
          description: 'fifo-related-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: false,
        },
      ]);
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        notificationProcessing: boolean;
        notificationQueue: Array<{ taskId: string }>;
      };
      internals.todoStopGuardQueuedPromptPriority = true;
      internals.notificationProcessing = true;
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('related result', '<fifo-related-result />', {
        agentId: 'fifo-related-agent',
        status: 'completed',
      });
      for (const oldAgent of oldAgents) {
        callback('old result', '<fifo-old-result />', {
          agentId: oldAgent.id,
          status: 'completed',
        });
      }

      expect(internals.notificationQueue).toHaveLength(20);
      expect(
        internals.notificationQueue.some(
          (item) => item.taskId === 'fifo-related-agent',
        ),
      ).toBe(true);
      internals.notificationProcessing = false;
    });

    it('unblocks deferred automatic work when history restoration clears trust', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'old-agent',
            description: 'old-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
          {
            id: 'new-agent',
            description: 'new-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();
      await runGuardPrompt();

      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('old result', '<old-result />', {
        agentId: 'old-agent',
        status: 'completed',
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      session.restoreHistory([]);

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });
    });

    it('does not let a related background result re-arm after rewind', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'pre-rewind-agent',
            description: 'pre-rewind-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();
      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'finish everything' }] },
        { role: 'model', parts: [{ text: 'working' }] },
      ];
      markApiHistoryPrompt(history[0]!, 'p1');
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue([
        {
          promptId: 'p1',
          timestamp: new Date('2026-10-09T00:00:00.000Z'),
          trackedFileBackups: {},
        },
      ]);
      session.rewindToTurn(0);

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'pre-rewind-agent',
          description: 'pre-rewind-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-after-rewind',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<pre-rewind-related-result />', {
        agentId: 'pre-rewind-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('does not let a related background result revive a hard-stopped guard', async () => {
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'hard-stopped-agent',
            description: 'hard-stopped-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      session.clearTodoStopGuardTrust();
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'hard-stopped-agent',
          description: 'hard-stopped-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'related-notification-todo-after-hard-stop',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<hard-stopped-related-result />', {
        agentId: 'hard-stopped-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardAttempts).toHaveLength(0);
    });

    it('does not let an unrelated background result clear hard suspension', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'baseline-agent',
          description: 'baseline-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      session.hardSuspendTodoStopGuard();
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'baseline-agent',
          description: 'baseline-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      installPendingTodoTool();
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'unrelated-notification-todo-after-hard-stop',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<hard-stopped-unrelated-result />', {
        agentId: 'baseline-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      const internals = session as unknown as {
        todoStopGuard: { isHardSuspended: boolean };
      };
      expect(internals.todoStopGuard.isHardSuspended).toBe(true);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([params]) =>
              params.update.sessionUpdate === 'agent_message_chunk' &&
              params.update._meta?.['source'] === 'todo_stop_guard',
          ),
      ).toBe(false);
    });

    it('retains an already-used attempt when a related background task completes', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-background',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockImplementationOnce(async () => {
          mockBackgroundTaskRegistry.getAll.mockReturnValue([
            {
              id: 'guard-agent',
              description: 'guard-agent',
              isBackgrounded: true,
              status: 'running',
              notified: false,
            },
          ]);
          return createEmptyStream();
        })
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'guard-agent',
          description: 'guard-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'guard-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      });
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it('does not let a pre-existing task notification revive an exhausted guard', async () => {
      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'running',
          notified: false,
        },
      ]);
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      await runGuardPrompt();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);

      mockBackgroundTaskRegistry.getAll.mockReturnValue([
        {
          id: 'old-agent',
          description: 'old-agent',
          isBackgrounded: true,
          status: 'completed',
          notified: true,
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'notification-todo',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('old background done', '<task-notification />', {
        agentId: 'old-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
    });

    it('coalesces a blocking external Stop hook with the guard', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop')
            return { success: true, output: {} };
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: { decision: 'block', reason: 'hook says continue' },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const combined = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as {
        message: Part[];
      };
      expect(textParts(combined.message).join('\n')).toContain(
        'hook says continue',
      );
      expect(textParts(combined.message).join('\n')).toContain(
        '[Todo Stop Guard]',
      );
    });

    it('preserves the external Stop hook tool loop after Guard exhaustion', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readExecute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: readExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      const readCall = (id: string) =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id,
                  name: 'read_file',
                  args: { path: '/tmp/test.txt' },
                },
              ],
            },
          },
        ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-coalesced-tool-loop',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(readCall('coalesced-read-1'))
        .mockResolvedValueOnce(readCall('coalesced-read-2'))
        .mockResolvedValueOnce(createEmptyStream());
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: { decision: 'block', reason: 'hook says continue' },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      expect(readExecute).toHaveBeenCalledTimes(2);
      const externalToolFollowup = vi.mocked(mockChat.sendMessageStream).mock
        .calls[4]?.[1] as { message: Part[] };
      expect(
        externalToolFollowup.message.some(
          (part) =>
            'functionResponse' in part &&
            part.functionResponse?.id === 'coalesced-read-2',
        ),
      ).toBe(true);
      expect(textParts(externalToolFollowup.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it('preserves an external Stop hook tool result when nested Guard validation defers', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readExecute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: readExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-coalesced-background-race',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'coalesced-read-before-background-race',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: 'external hook owns the tool loop',
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      let drainCalls = 0;
      mockGuardBridge(async () => {
        drainCalls++;
        if (drainCalls === 6) {
          mockBackgroundTaskRegistry.getAll.mockReturnValue([
            {
              id: 'related-during-nested-validation',
              isBackgrounded: true,
              status: 'running',
              notified: false,
            },
          ]);
        }
        return { messages: [], hasQueuedPrompt: false };
      });

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const externalToolResult = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(
        externalToolResult.message.some(
          (part) =>
            'functionResponse' in part &&
            part.functionResponse?.id ===
              'coalesced-read-before-background-race',
        ),
      ).toBe(true);
      expect(textParts(externalToolResult.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
    });

    it('preserves an external Stop hook tool result when a nested Guard claim is unavailable', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      const todoTool = mockToolRegistry.getTool(core.ToolNames.TODO_WRITE);
      const readExecute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      const readTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          execute: readExecute,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      };
      mockToolRegistry.getTool.mockImplementation((name: string) =>
        name === core.ToolNames.TODO_WRITE ? todoTool : readTool,
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-unavailable-nested-claim',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'coalesced-read-before-unavailable-nested-claim',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: 'external hook owns nested tool result',
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      let claimCalls = 0;
      mockGuardBridge(
        async () => ({ messages: [], hasQueuedPrompt: false }),
        async () =>
          ++claimCalls === 1
            ? { claimed: true, hasQueuedPrompt: false }
            : { claimed: false, hasQueuedPrompt: false },
      );

      await runGuardPrompt();

      expect(claimCalls).toBe(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const externalToolResult = vi.mocked(mockChat.sendMessageStream).mock
        .calls[3]?.[1] as { message: Part[] };
      expect(
        externalToolResult.message.some(
          (part) =>
            'functionResponse' in part &&
            part.functionResponse?.id ===
              'coalesced-read-before-unavailable-nested-claim',
        ),
      ).toBe(true);
      expect(textParts(externalToolResult.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
    });

    it('reports Guard exhaustion before a coalesced external Stop hook reaches its cap', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(3);
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? { decision: 'block', reason: 'hook keeps blocking' }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      const guardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardUpdates.map((update) => update._meta?.['attempt'])).toEqual([
        1, 2, 2,
      ]);
      expect(
        guardUpdates.at(-1)?.content.type === 'text'
          ? guardUpdates.at(-1)?.content.text
          : '',
      ).toContain('Automatic continuation stopped after 2 attempts');
    });

    it('resets consecutive Stop-hook blocks after a nonblocking allow', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
      let stopCalls = 0;
      const stopActiveFlags: unknown[] = [];
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          stopActiveFlags.push(request.input?.stop_hook_active);
          return stopCalls === 1 || stopCalls === 3
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: `nonconsecutive block ${stopCalls}`,
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(stopCalls).toBe(4);
      // Hook-forced turns report true; the guard's own continuation does not.
      expect(stopActiveFlags).toEqual([false, true, false, true]);
      expect(agentMessageChunks()).not.toContain(
        'Stop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
      );
    });

    it('reports stop_hook_active false after mid-turn user input replaces a hook-forced turn', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      Object.defineProperty(internals.todoStopGuard, 'needsStopInspection', {
        configurable: true,
        get: () => true,
      });
      let stopCalls = 0;
      let userInputDelivered = false;
      mockGuardBridge(() => {
        // Deliver user input on the drain that follows the second Stop check,
        // i.e. while the hook-forced turn is ending.
        if (stopCalls === 2 && !userInputDelivered) {
          userInputDelivered = true;
          return {
            messages: ['also update the changelog'],
            hasQueuedPrompt: false,
          };
        }
        return { messages: [], hasQueuedPrompt: false };
      });
      const stopActiveFlags: unknown[] = [];
      const messageBus = {
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
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(userInputDelivered).toBe(true);
      expect(stopActiveFlags.slice(0, 3)).toEqual([false, true, false]);
    });
    it('reports stop_hook_active false and restarts the block count when user input is drained before a Stop check', async () => {
      rebuildSessionWithGuard();
      // No pending todos, so the Guard never adds a continuation of its own
      // (which would drain input inside that continuation instead).
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      Object.defineProperty(internals.todoStopGuard, 'needsStopInspection', {
        configurable: true,
        get: () => true,
      });
      let stopCallsAtDelivery: number | undefined;
      let sendsAtDelivery: number | undefined;
      let stopCalls = 0;
      mockGuardBridge(() => {
        // Deliver on the first drain after the hook-forced continuation has
        // been sent: the check before that turn's own Stop.
        const sends = vi.mocked(mockChat.sendMessageStream).mock.calls.length;
        if (
          stopCalls === 1 &&
          sends >= 2 &&
          stopCallsAtDelivery === undefined
        ) {
          stopCallsAtDelivery = stopCalls;
          sendsAtDelivery = sends;
          return {
            messages: ['also update the changelog'],
            hasQueuedPrompt: false,
          };
        }
        return { messages: [], hasQueuedPrompt: false };
      });
      const stopActiveFlags: unknown[] = [];
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          stopActiveFlags.push(request.input?.stop_hook_active);
          return stopCalls <= 2
            ? {
                success: true,
                output: { decision: 'block', reason: `block ${stopCalls}` },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      // Delivered after the hook-forced continuation ran, before its Stop.
      expect(stopCallsAtDelivery).toBe(1);
      expect(sendsAtDelivery).toBe(2);
      // The user's turn is not hook-forced, and its block is the first of a
      // new run rather than the second consecutive one.
      expect(stopActiveFlags.slice(0, 2)).toEqual([false, false]);
      expect(stopCalls).toBeGreaterThanOrEqual(3);
      expect(agentMessageChunks()).not.toContain(
        'Stop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
      );
    });

    it('restarts the consecutive-block count when user input replaces the turn after a Stop check', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      Object.defineProperty(internals.todoStopGuard, 'needsStopInspection', {
        configurable: true,
        get: () => true,
      });
      let stopCalls = 0;
      let userInputDelivered = false;
      mockGuardBridge(() => {
        // The drain right after Stop 2 delivers user input, which discards
        // that Stop's block before it is applied.
        if (stopCalls === 2 && !userInputDelivered) {
          userInputDelivered = true;
          return {
            messages: ['also update the changelog'],
            hasQueuedPrompt: false,
          };
        }
        return { messages: [], hasQueuedPrompt: false };
      });
      const stopActiveFlags: unknown[] = [];
      const messageBus = {
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
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(userInputDelivered).toBe(true);
      expect(stopActiveFlags.slice(0, 4)).toEqual([false, true, false, true]);
      // Stop 3 blocked the user's turn: one block, not two consecutive ones.
      expect(stopCalls).toBeGreaterThanOrEqual(4);
      expect(agentMessageChunks()).not.toContain(
        'Stop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
      );
    });

    it('preserves a coalesced Stop-loop event when token rejection skips the final send', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(3);
      mockLlmClient.tryCompressChat.mockResolvedValue({
        originalTokenCount: 50,
        newTokenCount: 50,
        compressionStatus: core.CompressionStatus.NOOP,
      });
      const highUsageStream = createStreamWithChunks([
        {
          type: core.StreamEventType.CHUNK,
          value: {
            usageMetadata: {
              totalTokenCount: 101,
              promptTokenCount: 101,
            },
          },
        },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'todo-before-coalesced-token-limit',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(highUsageStream);
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? {
                  decision: 'block',
                  reason: 'coalesced hook continuation',
                }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await expect(runGuardPrompt()).resolves.toEqual({
        stopReason: 'max_tokens',
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update._meta?.['stopHookLoop'])
          .filter((meta) => meta !== undefined),
      ).toContainEqual(
        expect.objectContaining({
          iterationCount: 2,
          reasons: [
            'coalesced hook continuation',
            'coalesced hook continuation',
          ],
        }),
      );
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ text: 'coalesced hook continuation' }],
      });
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update._meta?.['attempt'])
          .filter((attempt) => attempt !== undefined),
      ).toEqual([1]);
    });

    it('rechecks user input after a slow external Stop hook', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['direction queued while the Stop hook was running'],
          hasQueuedPrompt: false,
        },
        { messages: [], hasQueuedPrompt: false },
      );

      let hookStarted!: () => void;
      const hookStartedPromise = new Promise<void>((resolve) => {
        hookStarted = resolve;
      });
      let releaseHook!: () => void;
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          if (++stopCalls === 1) {
            hookStarted();
            await hookGate;
          }
          return { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      const prompt = runGuardPrompt();
      await hookStartedPromise;
      releaseHook();
      await prompt;

      const userContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(userContinuation.message).join('\n')).toContain(
        'direction queued while the Stop hook was running',
      );
      const guardAttempts = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update._meta?.['source'] === 'todo_stop_guard',
        )
        .map((update) => update._meta?.['attempt']);
      expect(guardAttempts).toEqual([1, 2, 2]);
    });

    it('accounts for a slow blocking Stop hook after handling mid-turn input', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(1);
      mockGuardDrainResponses(
        { messages: [], hasQueuedPrompt: false },
        { messages: [], hasQueuedPrompt: false },
        {
          messages: ['direction queued while the Stop hook was running'],
          hasQueuedPrompt: false,
        },
        { messages: [], hasQueuedPrompt: false },
      );

      let hookStarted!: () => void;
      const hookStartedPromise = new Promise<void>((resolve) => {
        hookStarted = resolve;
      });
      let releaseHook!: () => void;
      const hookGate = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      let stopCalls = 0;
      const stopInputs: string[] = [];
      mockChat.getLastModelMessageText = vi
        .fn()
        .mockImplementation(() =>
          stopCalls === 0
            ? 'response before mid-turn continuation'
            : 'response after mid-turn continuation',
        );
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopInputs.push(request.input.last_assistant_message);
          if (++stopCalls === 1) {
            hookStarted();
            await hookGate;
            return {
              success: true,
              output: {
                decision: 'block',
                reason: 'continue after the slow Stop hook',
                systemMessage: 'slow Stop hook system message',
              },
            };
          }
          return { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      const prompt = runGuardPrompt();
      await hookStartedPromise;
      releaseHook();

      await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });

      expect(stopCalls).toBeGreaterThanOrEqual(2);
      expect(stopInputs.slice(0, 2)).toEqual([
        'response before mid-turn continuation',
        'response after mid-turn continuation',
      ]);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      const userContinuation = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(userContinuation.message).join('\n')).toContain(
        'direction queued while the Stop hook was running',
      );
      expect(agentMessageChunks()).not.toContain(
        'slow Stop hook system message',
      );
      expect(agentMessageChunks()).not.toContain(
        'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
      );
    });

    it.each([
      {
        label: 'keeps the external continuation when the claim is unavailable',
        claim: { claimed: false, hasQueuedPrompt: false },
        expectedModelCalls: 3,
        expectedStopCalls: 2,
        keepsHookOutput: true,
      },
      {
        label: 'discards the stale hook response when a FIFO prompt is live',
        claim: { claimed: false, hasQueuedPrompt: true },
        expectedModelCalls: 2,
        expectedStopCalls: 1,
        keepsHookOutput: false,
      },
    ])(
      '$label after a slow Stop hook',
      async ({
        claim,
        expectedModelCalls,
        expectedStopCalls,
        keepsHookOutput,
      }) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        let queuedPromptArrived = false;
        mockGuardBridge(
          async () => ({
            messages: [],
            hasQueuedPrompt: queuedPromptArrived,
          }),
          async () => claim,
        );
        let hookStarted!: () => void;
        const hookStartedPromise = new Promise<void>((resolve) => {
          hookStarted = resolve;
        });
        let releaseHook!: () => void;
        const hookGate = new Promise<void>((resolve) => {
          releaseHook = resolve;
        });
        let stopCalls = 0;
        const messageBus = {
          request: vi.fn().mockImplementation(async (request) => {
            if (request.eventName !== 'Stop') {
              return { success: true, output: {} };
            }
            stopCalls++;
            if (stopCalls === 1) {
              hookStarted();
              await hookGate;
              return {
                success: true,
                output: {
                  decision: 'block',
                  reason: 'external hook continuation',
                  systemMessage: 'hook response before queue inspection',
                },
              };
            }
            return { success: true, output: {} };
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((name: string) => name === 'Stop');

        const prompt = runGuardPrompt();
        await hookStartedPromise;
        queuedPromptArrived = true;
        releaseHook();
        await prompt;

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(
          expectedModelCalls,
        );
        expect(stopCalls).toBe(expectedStopCalls);
        expect(
          agentMessageChunks().includes(
            'hook response before queue inspection',
          ),
        ).toBe(keepsHookOutput);
        if (keepsHookOutput) {
          const externalCall = vi.mocked(mockChat.sendMessageStream).mock
            .calls[2]?.[1] as { message: Part[] };
          expect(textParts(externalCall.message).join('\n')).toContain(
            'external hook continuation',
          );
          expect(textParts(externalCall.message).join('\n')).not.toContain(
            '[Todo Stop Guard]',
          );
        }
      },
    );

    it('keeps an external Stop hook when an earlier queued-prompt probe is unavailable', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(
        async () => ({ messages: [], hasQueuedPrompt: true }),
        async () => ({ claimed: false, hasQueuedPrompt: false }),
      );
      let stopCalls = 0;
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          return stopCalls === 1
            ? {
                success: true,
                output: {
                  decision: 'block',
                  reason: 'external hook after unavailable probe',
                },
              }
            : { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(stopCalls).toBe(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      const externalCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(externalCall.message).join('\n')).toContain(
        'external hook after unavailable probe',
      );
      expect(textParts(externalCall.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
    });

    it('sends drained user input when a Guard preparation claim is unavailable', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      let hookReturned = false;
      let drainsAfterHook = 0;
      mockGuardBridge(
        async () => {
          if (!hookReturned) {
            return { messages: [], hasQueuedPrompt: false };
          }
          drainsAfterHook++;
          return drainsAfterHook === 2
            ? {
                messages: ['user input during Guard preparation'],
                hasQueuedPrompt: true,
              }
            : { messages: [], hasQueuedPrompt: false };
        },
        async () => ({ claimed: false, hasQueuedPrompt: false }),
      );
      let stopCalls = 0;
      const stopActiveFlags: unknown[] = [];
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => {
          if (request.eventName !== 'Stop') {
            return { success: true, output: {} };
          }
          stopCalls++;
          stopActiveFlags.push(request.input?.stop_hook_active);
          if (stopCalls === 1) {
            hookReturned = true;
            return {
              success: true,
              output: {
                decision: 'block',
                reason: 'superseded external continuation',
              },
            };
          }
          return { success: true, output: {} };
        }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');

      await runGuardPrompt();

      expect(stopCalls).toBe(2);
      // Queued user input replaced the hook-forced continuation.
      expect(stopActiveFlags).toEqual([false, false]);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      const userCall = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(userCall.message).join('\n')).toContain(
        'user input during Guard preparation',
      );
      expect(textParts(userCall.message).join('\n')).not.toContain(
        'superseded external continuation',
      );
      expect(textParts(userCall.message).join('\n')).not.toContain(
        '[Todo Stop Guard]',
      );
    });

    it('does not wait for a same-chain notification withheld by Guard lineage', async () => {
      rebuildSessionWithGuard();
      const monitor = {
        id: 'owned-monitor',
        description: 'Monitor outliving its owner',
        status: 'running',
        ownerAgentId: 'monitor-owner',
        todoWorkChainId: 'test-session-id########1',
      };
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: monitor.ownerAgentId,
            status: 'completed',
            isBackgrounded: false,
            notified: true,
          },
        ]);
        mockMonitorRegistry.getAll.mockReturnValue([monitor]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();
      const internals = session as unknown as {
        pendingPromptCompletion: unknown;
        todoStopGuard: { blocksUnrelatedAutomaticTurns: boolean };
        notificationQueue: Array<{
          todoWorkChainId?: string;
          continuesTodoStopGuardWorkChain: boolean;
        }>;
      };
      let settled = false;
      const resultPromise = runGuardPrompt(true).then((result) => {
        settled = true;
        return result;
      });
      try {
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(internals.pendingPromptCompletion).toBeNull();
        });
        expect(internals.todoStopGuard.blocksUnrelatedAutomaticTurns).toBe(
          true,
        );
        // A monitor can outlive the terminal agent registry entry that owns it.
        mockBackgroundTaskRegistry.getAll.mockReturnValue([]);
        monitor.status = 'completed';
        mockMonitorRegistry.setNotificationCallback.mock.calls.at(-1)?.[0](
          'done',
          '<task-notification />',
          {
            monitorId: monitor.id,
            ownerAgentId: monitor.ownerAgentId,
            status: 'completed',
            todoWorkChainId: monitor.todoWorkChainId,
          },
        );
        expect(internals.notificationQueue).toEqual([
          expect.objectContaining({
            todoWorkChainId: monitor.todoWorkChainId,
            continuesTodoStopGuardWorkChain: false,
          }),
        ]);
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(await resultPromise).toMatchObject({ stopReason: 'end_turn' });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(internals.notificationQueue).toHaveLength(1);
      } finally {
        session.dispose();
        await resultPromise;
      }
    });

    it('drains related per_task output before admitting an unrelated queue head', async () => {
      const daemonPromptId = 'waiting-channel-with-unrelated-head';
      const daemon = bindDaemonGuardBridge(daemonPromptId);
      const task = {
        id: 'related-task',
        description: 'Related task',
        status: 'running',
        isBackgrounded: true,
        notified: false,
        todoWorkChainId: 'test-session-id########1',
      };
      mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
      const textStream = (text: string) =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: { candidates: [{ content: { parts: [{ text }] } }] },
          },
        ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(textStream('Main result'))
        .mockResolvedValueOnce(textStream('Related result'))
        .mockResolvedValueOnce(textStream('Unrelated result'));
      const resultPromise = session
        .prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
            _meta: {
              [CHANNEL_PROMPT_META_KEY]: true,
              [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
            },
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: daemonPromptId,
          },
        )
        .finally(() => {
          daemon.promptActive = false;
          daemon.activePromptId = undefined;
          daemon.pendingPromptList.length = 0;
        });
      try {
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          expect(
            (session as unknown as { pendingPromptCompletion: unknown })
              .pendingPromptCompletion,
          ).toBeNull();
        });
        const notify =
          mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
            -1,
          )![0];
        notify('unrelated done', '<unrelated-result />', {
          agentId: 'unrelated-task',
          status: 'completed',
          todoWorkChainId: 'another-chain',
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          '_qwencode/start_turn',
          expect.anything(),
        );
        task.status = 'completed';
        task.notified = true;
        notify('related done', '<related-result />', {
          agentId: task.id,
          status: 'completed',
          todoWorkChainId: task.todoWorkChainId,
        });
        const result = await resultPromise;
        expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
          'Related result',
        );
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3),
        );
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          '_qwencode/start_turn',
          expect.objectContaining({ taskId: 'unrelated-task' }),
        );
        const responses = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update)
          .filter(
            (update) =>
              update._meta?.['source'] === 'background_notification_response',
          );
        expect(responses).toContainEqual(
          expect.objectContaining({
            content: { type: 'text', text: 'Related result' },
            _meta: expect.objectContaining({
              [CHANNEL_TASK_OUTPUT_META_KEY]: true,
            }),
          }),
        );
        await vi.waitFor(() => {
          const unrelated = vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.map(([params]) => params.update)
            .find(
              (update) =>
                update.sessionUpdate === 'agent_message_chunk' &&
                update.content.type === 'text' &&
                update.content.text === 'Unrelated result',
            );
          expect(unrelated?._meta?.['backgroundTurn']).toMatchObject({
            taskId: 'unrelated-task',
          });
          expect(
            unrelated?._meta?.[CHANNEL_TASK_OUTPUT_META_KEY],
          ).toBeUndefined();
        });
      } finally {
        session.dispose();
        await resultPromise;
      }
    });

    it('readmits a notification independently when its per_task owner cancels during admission', async () => {
      const daemonPromptId = 'cancelled-before-background-admission';
      const daemon = bindDaemonGuardBridge(daemonPromptId);
      const task = {
        id: 'admission-task',
        description: 'Related task',
        status: 'running',
        isBackgrounded: true,
        notified: false,
        todoWorkChainId: 'test-session-id########1',
      };
      mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
      mockChat.sendMessageStream = vi.fn().mockImplementation(async () =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [
                { content: { parts: [{ text: 'Background result' }] } },
              ],
            },
          },
        ]),
      );
      const cancellation = new AbortController();
      const resultPromise = session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
          _meta: {
            [CHANNEL_PROMPT_META_KEY]: true,
            [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
          },
        },
        { version: 1, sessionId: 'test-session-id', promptId: daemonPromptId },
        cancellation.signal,
      );
      let releaseAdmission!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      let admissionStarted = false;
      try {
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          expect(
            (session as unknown as { pendingPromptCompletion: unknown })
              .pendingPromptCompletion,
          ).toBeNull();
        });
        mockConfig.assertCanStartTurn = vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(async () => {
            admissionStarted = true;
            await gate;
          })
          .mockResolvedValue(undefined);
        task.status = 'completed';
        task.notified = true;
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0]('done', '<task-notification />', {
          agentId: task.id,
          status: 'completed',
          todoWorkChainId: task.todoWorkChainId,
        });
        await vi.waitFor(() => expect(admissionStarted).toBe(true));
        cancellation.abort();
        expect((await resultPromise).stopReason).toBe('cancelled');
        daemon.promptActive = false;
        daemon.activePromptId = undefined;
        daemon.pendingPromptList.length = 0;
        releaseAdmission();
        await vi.waitFor(() =>
          expect(
            (session as unknown as { notificationAdmissionDeferred: boolean })
              .notificationAdmissionDeferred,
          ).toBe(true),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(session.getBackgroundTurn()).toBeUndefined();
        await vi.waitFor(
          () =>
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              expect.objectContaining({
                source: 'background_notification',
                turnId: expect.any(String),
              }),
            ),
          { timeout: 2500 },
        );
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          '_qwencode/start_turn',
          expect.objectContaining({ taskId: task.id }),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        const response = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update)
          .find(
            (update) =>
              update._meta?.['source'] === 'background_notification_response',
          );
        expect(response?._meta?.[CHANNEL_TASK_OUTPUT_META_KEY]).toBeUndefined();
        expect(response?._meta?.['backgroundTurn']).toMatchObject({
          taskId: task.id,
        });
      } finally {
        releaseAdmission();
        session.dispose();
        await resultPromise;
      }
    });

    it.each(['foreground', 'background'] as const)(
      'cancels the per_task wait when the %s Guard yields to a queued prompt',
      async (yieldPhase) => {
        rebuildSessionWithGuard();
        session.dispose();
        const agents = new core.BackgroundTaskRegistry();
        vi.mocked(mockConfig.getBackgroundTaskRegistry).mockReturnValue(agents);
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        if (yieldPhase === 'background') {
          const notificationStream = mockChat.sendMessageStream;
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createEmptyStream())
            .mockImplementation(notificationStream);
        }
        const daemonPromptId = 'waiting-channel-prompt';
        const daemon = bindDaemonGuardBridge(daemonPromptId);
        daemon.pendingPromptList.push({
          promptId: 'queued-web-prompt',
          state: 'queued',
          queuedAt: Date.now(),
          text: 'next user request',
          abortController: new AbortController(),
        });
        const task = agents.register({
          agentId: 'queued-guard-background',
          description: 'Related background task',
          isBackgrounded: true,
          status: 'running',
          startTime: Date.now(),
          abortController: new AbortController(),
          outputFile: path.join(os.tmpdir(), `${randomUUID()}.jsonl`),
          todoWorkChainId: 'test-session-id########1',
        });
        let settled = false;
        const resultPromise = session
          .prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'finish the task' }],
              _meta: {
                [CHANNEL_PROMPT_META_KEY]: true,
                [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
              },
            },
            {
              version: 1,
              sessionId: 'test-session-id',
              promptId: daemonPromptId,
            },
          )
          .then((result) => {
            settled = true;
            return result;
          });
        try {
          await vi.waitFor(() => {
            expect(mockChat.sendMessageStream).toHaveBeenCalled();
            expect(
              (session as unknown as { pendingPromptCompletion: unknown })
                .pendingPromptCompletion,
            ).toBeNull();
          });
          agents.complete(task.id, 'background completed');
          await vi.waitFor(() => expect(settled).toBe(true));
          const result = await resultPromise;
          expect(result.stopReason).toBe('cancelled');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
          expect(task.status).toBe('completed');
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
            { sessionId: 'test-session-id', promptId: daemonPromptId },
          );

          daemon.pendingPromptList.shift();
          daemon.pendingPromptList[0].state = 'running';
          daemon.activePromptId = 'queued-web-prompt';
          await expect(
            session.prompt(
              {
                sessionId: 'test-session-id',
                prompt: [{ type: 'text', text: 'next user request' }],
              },
              {
                version: 1,
                sessionId: 'test-session-id',
                promptId: 'queued-web-prompt',
              },
            ),
          ).resolves.toMatchObject({ stopReason: 'end_turn' });
        } finally {
          session.dispose();
          await resultPromise;
        }
      },
    );

    it.each(['unrelated', 'cancelled', 'cancelled-before-claim'] as const)(
      'keeps background Guard ownership isolated for a %s per_task capture',
      async (boundary) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        const notificationStream = mockChat.sendMessageStream;
        let releaseNotification!: () => void;
        const notificationGate = new Promise<void>((resolve) => {
          releaseNotification = resolve;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockImplementationOnce(
            async (...args: Parameters<typeof notificationStream>) => {
              if (boundary === 'cancelled-before-claim') await notificationGate;
              return notificationStream(...args);
            },
          )
          .mockImplementation(notificationStream);
        const daemonPromptId = 'guard-owner-boundary';
        bindDaemonGuardBridge(daemonPromptId);
        const callDaemon = vi
          .mocked(mockClient.extMethod)
          .getMockImplementation()!;
        const claimParams: unknown[] = [];
        let releaseFlush: (() => void) | undefined;
        let releaseClaim!: () => void;
        const claimGate = new Promise<void>((resolve) => {
          releaseClaim = resolve;
        });
        vi.mocked(mockClient.extMethod).mockImplementation(
          async (method, params) => {
            const result = await callDaemon(method, params);
            if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
              claimParams.push(params);
              await claimGate;
            }
            return result;
          },
        );
        const task = {
          id: 'guard-owned-task',
          description: 'Related background task',
          status: 'running',
          isBackgrounded: true,
          todoWorkChainId: 'test-session-id########1',
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        const cancellation = new AbortController();
        let settled = false;
        const resultPromise = session
          .prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'finish the task' }],
              _meta: {
                [CHANNEL_PROMPT_META_KEY]: true,
                [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
              },
            },
            {
              version: 1,
              sessionId: 'test-session-id',
              promptId: daemonPromptId,
            },
            cancellation.signal,
          )
          .then((result) => {
            settled = true;
            return result;
          });
        try {
          await vi.waitFor(() => {
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            expect(
              (session as unknown as { pendingPromptCompletion: unknown })
                .pendingPromptCompletion,
            ).toBeNull();
          });
          if (boundary !== 'unrelated') task.status = 'completed';
          mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
            -1,
          )?.[0]('done', '<task-notification />', {
            agentId: boundary === 'unrelated' ? 'another-task' : task.id,
            status: 'completed',
            todoWorkChainId:
              boundary === 'unrelated' ? 'another-chain' : task.todoWorkChainId,
          });
          if (boundary === 'unrelated') {
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(mockClient.extMethod).not.toHaveBeenCalledWith(
              '_qwencode/start_turn',
              expect.anything(),
            );
            expect(claimParams).toEqual([]);
            expect(settled).toBe(false);
            cancellation.abort();
            expect((await resultPromise).stopReason).toBe('cancelled');
            return;
          }
          if (boundary === 'cancelled-before-claim') {
            await vi.waitFor(() =>
              expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
            );
            mockChatRecordingService.flush.mockImplementationOnce(
              () =>
                new Promise<void>((resolve) => {
                  releaseFlush = resolve;
                }),
            );
            cancellation.abort();
            await vi.waitFor(() => expect(releaseFlush).toBeDefined());
            expect(
              (session as unknown as { channelTaskCaptures: Set<unknown> })
                .channelTaskCaptures.size,
            ).toBe(1);
            releaseNotification();
          }
          await vi.waitFor(() => expect(claimParams.length).toBeGreaterThan(0));
          expect(claimParams[0]).toEqual({
            sessionId: 'test-session-id',
            ...(boundary === 'cancelled' ? { promptId: daemonPromptId } : {}),
          });
          if (boundary === 'cancelled') cancellation.abort();
          releaseClaim();
          await vi.waitFor(() => {
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              {
                sessionId: 'test-session-id',
                reason: 'end_turn',
                source: 'background_notification',
              },
            );
          });
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
          if (boundary === 'cancelled-before-claim') {
            expect(claimParams).toEqual([{ sessionId: 'test-session-id' }]);
          }
          releaseFlush?.();
          const result = await resultPromise;
          expect(result.stopReason).toBe('cancelled');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
        } finally {
          releaseNotification();
          releaseFlush?.();
          releaseClaim();
          session.dispose();
          await resultPromise;
        }
      },
    );

    it.each([undefined, 'per_task'] as const)(
      'routes background notification Guard continuations with one final boundary in %s mode',
      async (outputMode) => {
        rebuildSessionWithGuard();
        const daemonPromptId = 'guard-channel-prompt';
        const daemon = bindDaemonGuardBridge(daemonPromptId);
        const completedTodos = pendingTodos.map((todo) => ({
          ...todo,
          status: 'completed' as const,
        }));
        const execute = installPendingTodoTool();
        const todoResult = (
          todos: typeof pendingTodos | typeof completedTodos,
        ) => ({
          llmContent: JSON.stringify(todos),
          returnDisplay: { type: 'todo_list', todos, changes: {} },
        });
        const toolContexts: unknown[] = [];
        execute.mockImplementation(async () => {
          toolContexts.push(core.getInvocationContext());
          return todoResult(
            toolContexts.length === 1 ? pendingTodos : completedTodos,
          );
        });
        const textStream = (...texts: string[]) =>
          createStreamWithChunks(
            texts.map((text) => ({
              type: core.StreamEventType.CHUNK,
              value: { candidates: [{ content: { parts: [{ text }] } }] },
            })),
          );
        const largeResultPrefix = 'B'.repeat(
          core.TURN_RESULT_TEXT_MAX_CHARS + 1,
        );
        const finalResponse = `${largeResultPrefix}Result B after Guard continuation`;
        const todoStream = (
          id: string,
          todos: typeof pendingTodos | typeof completedTodos,
        ) =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  { id, name: core.ToolNames.TODO_WRITE, args: { todos } },
                ],
              },
            },
          ]);
        const workChainId = 'test-session-id########1';
        const task = {
          id: 'guard-background',
          description: 'Related background task',
          isBackgrounded: true,
          status: 'running',
          notified: false,
          todoWorkChainId: workChainId,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockResolvedValueOnce(todoStream('notification-todo', pendingTodos))
          .mockResolvedValueOnce(
            textStream('Result A before Guard continuation'),
          )
          .mockResolvedValueOnce(
            todoStream('guard-completes-todo', completedTodos),
          )
          .mockResolvedValueOnce(
            textStream(largeResultPrefix, 'Result B after Guard continuation'),
          )
          .mockResolvedValue(createEmptyStream());
        const resultPromise = session
          .prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'finish the task' }],
              _meta: {
                [CHANNEL_PROMPT_META_KEY]: true,
                ...(outputMode
                  ? { [CHANNEL_OUTPUT_MODE_META_KEY]: outputMode }
                  : {}),
              },
            },
            {
              version: 1,
              sessionId: 'test-session-id',
              promptId: daemonPromptId,
            },
          )
          .finally(() => {
            daemon.promptActive = false;
            daemon.activePromptId = undefined;
            daemon.pendingPromptList.length = 0;
          });
        try {
          await vi.waitFor(() => {
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            expect(
              (session as unknown as { pendingPromptCompletion: unknown })
                .pendingPromptCompletion,
            ).toBeNull();
          });
          task.status = 'completed';
          task.notified = true;
          const callback =
            mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
              -1,
            )?.[0];
          callback('background done', '<task-notification />', {
            agentId: task.id,
            status: 'completed',
            todoWorkChainId: workChainId,
          });
          await vi.waitFor(() => {
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              {
                sessionId: 'test-session-id',
                reason: 'end_turn',
                source: 'background_notification',
                ...(!outputMode ? { turnId: expect.any(String) } : {}),
              },
            );
          });
          const result = await resultPromise;
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
          expect(toolContexts).toEqual([undefined, undefined]);
          const backgroundStart = vi
            .mocked(mockClient.extMethod)
            .mock.calls.find(([method]) => method === '_qwencode/start_turn');
          expect(Boolean(backgroundStart)).toBe(!outputMode);
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
            {
              sessionId: 'test-session-id',
              promptId: outputMode
                ? daemonPromptId
                : backgroundStart?.[1]['turnId'],
            },
          );
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
            outputMode ? finalResponse : undefined,
          );
          const backgroundResponses = vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.map(([params]) => params.update)
            .filter(
              (update) =>
                update._meta?.['source'] === 'background_notification_response',
            );
          expect(backgroundResponses).toEqual([
            expect.objectContaining({
              content: {
                type: 'text',
                text: 'Result A before Guard continuation',
              },
              _meta: expect.objectContaining({
                backgroundTask: expect.objectContaining({
                  turnComplete: false,
                }),
              }),
            }),
            expect.objectContaining({
              content: {
                type: 'text',
                text: finalResponse,
              },
              _meta: expect.objectContaining({
                backgroundTask: expect.objectContaining({
                  turnComplete: false,
                }),
              }),
            }),
            expect.objectContaining({
              content: { type: 'text', text: '' },
              _meta: expect.objectContaining({
                backgroundTask: expect.objectContaining({ turnComplete: true }),
              }),
            }),
          ]);
          expect(
            backgroundResponses.map(
              (update) => update._meta?.[CHANNEL_TASK_OUTPUT_META_KEY],
            ),
          ).toEqual(
            outputMode ? [true, true, true] : [undefined, undefined, undefined],
          );
          expect(
            vi.mocked(mockClient.sessionUpdate).mock.calls.some(([params]) => {
              const update = params.update;
              return (
                update.sessionUpdate === 'agent_message_chunk' &&
                update.content.type === 'text' &&
                update.content.text === finalResponse &&
                update._meta?.['source'] !== 'background_notification_response'
              );
            }),
          ).toBe(false);
        } finally {
          session.dispose();
          await resultPromise;
        }
      },
    );

    it('automatic guard claims its actual background execution owner', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      mockGuardBridge(async () => ({ messages: [], hasQueuedPrompt: false }));
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'automatic-agent',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/end_turn',
          expect.objectContaining({ source: 'background_notification' }),
        ),
      );
      const start = vi
        .mocked(mockClient.extMethod)
        .mock.calls.find(([method]) => method === '_qwencode/start_turn');
      const claims = vi
        .mocked(mockClient.extMethod)
        .mock.calls.filter(
          ([method]) => method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
        );
      expect(start?.[1]?.['turnId']).toEqual(expect.any(String));
      expect(claims.length).toBeGreaterThan(0);
      for (const [, params] of claims) {
        expect(params).toMatchObject({
          sessionId: 'test-session-id',
          promptId: start?.[1]?.['turnId'],
        });
      }
    });

    it.each(['inactive', 'foreign'] as const)(
      'rejects %s background context when claiming ordinary guard',
      async (scope) => {
        rebuildSessionWithGuard();
        installPendingTodoTool();
        queuePendingTodoThenNaturalStops();
        mockGuardBridge(async () => ({ messages: [], hasQueuedPrompt: false }));
        await core.backgroundTurnContext.run(
          {
            sessionId:
              scope === 'foreign' ? 'another-session' : 'test-session-id',
            active: scope !== 'inactive',
            turn: {
              turnId: 'must-not-leak',
              taskId: 'task',
              kind: 'agent',
              startedAt: 1,
            },
          },
          runGuardPrompt,
        );
        const claims = vi
          .mocked(mockClient.extMethod)
          .mock.calls.filter(
            ([method]) => method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
          );
        expect(claims.length).toBeGreaterThan(0);
        for (const [, params] of claims) {
          expect(params).toMatchObject({
            sessionId: 'test-session-id',
            promptId: lastGuardPromptId,
          });
        }
      },
    );

    it('lets an independent background notification arm its own guard', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? {
                  decision: 'block',
                  reason: 'must not run automatically',
                }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

      callback('background done', '<task-notification />', {
        agentId: 'automatic-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });
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
      expect(
        messageBus.request.mock.calls.some(
          ([request]) => request.eventName === 'Stop',
        ),
      ).toBe(false);
    });

    it('suspends an armed guard when a background notification stream aborts', async () => {
      rebuildSessionWithGuard();
      const aborting = createDeferredAbortStream();
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(aborting.responseStream);

      await runGuardPrompt();
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;
      callback('background done', '<task-notification />', {
        agentId: 'automatic-agent',
        status: 'completed',
      });

      await aborting.started;
      const internals = session as unknown as {
        notificationAbortController: AbortController | null;
        notificationProcessing: boolean;
        todoStopGuard: {
          blocksUnrelatedAutomaticTurns: boolean;
          observeTodoWrite(resultDisplay: unknown, allowArm: boolean): boolean;
        };
      };
      internals.todoStopGuard.observeTodoWrite(
        { type: 'todo_list', todos: pendingTodos },
        true,
      );
      expect(internals.todoStopGuard.blocksUnrelatedAutomaticTurns).toBe(true);
      internals.notificationAbortController?.abort();
      aborting.abort();

      await vi.waitFor(() => {
        expect(internals.notificationProcessing).toBe(false);
      });
      expect(internals.todoStopGuard.blocksUnrelatedAutomaticTurns).toBe(false);
    });

    it('lets an independent cron turn arm its own guard', async () => {
      let fireCron!: (job: {
        prompt: string;
        cronExpr: string;
        missed?: boolean;
      }) => void;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              prompt: string;
              cronExpr: string;
              missed?: boolean;
            }) => void,
          ) => {
            fireCron = callback;
          },
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      installPendingTodoTool();
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
                    id: 'cron-todo',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();
      const messageBus = {
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? {
                  decision: 'block',
                  reason: 'must not run automatically',
                }
              : {},
        })),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((name: string) => name === 'Stop');
      fireCron({ prompt: 'scheduled work', cronExpr: '* * * * *' });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(5);
      });
      const guardUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.filter(
          ([params]) =>
            params.update.sessionUpdate === 'agent_message_chunk' &&
            params.update._meta?.['source'] === 'todo_stop_guard',
        );
      expect(guardUpdates).toHaveLength(3);
      expect(
        messageBus.request.mock.calls.some(
          ([request]) => request.eventName === 'Stop',
        ),
      ).toBe(false);
    });

    it('keeps a cron turn graceful when its Stop continuation trips loop protection', async () => {
      let fireCron!: (job: {
        prompt: string;
        cronExpr: string;
        missed?: boolean;
      }) => void;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              prompt: string;
              cronExpr: string;
              missed?: boolean;
            }) => void,
          ) => {
            fireCron = callback;
          },
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      installPendingTodoTool();
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
                    id: 'cron-todo',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'cron-loop-1',
                    name: 'read_file',
                    args: { path: 'a' },
                  },
                  {
                    id: 'cron-loop-2',
                    name: 'read_file',
                    args: { path: 'b' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();
      // Explicit one-call cap: the cron turn's Stop-continuation batch of
      // two calls trips the per-turn cap inside #runStopContinuation, the
      // shared path cron and background-notification turns reach through
      // #handleStopHookLoop.
      mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
      mockConfig.isMaxToolCallsPerTurnExplicit = vi.fn().mockReturnValue(true);
      fireCron({ prompt: 'scheduled work', cronExpr: '* * * * *' });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });
      expect(logLoopDetectedSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
        }),
        {},
      );
      expect(
        vi.mocked(mockClient.sessionUpdate).mock.calls.some(([params]) => {
          const update = params.update;
          return (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text.includes('[cron error]')
          );
        }),
      ).toBe(false);
    });

    it('keeps a background-notification turn graceful when its Stop continuation trips loop protection', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
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
                    id: 'notification-todo',
                    name: core.ToolNames.TODO_WRITE,
                    args: { todos: pendingTodos },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  {
                    content: { parts: [{ text: 'Partial guarded finding.' }] },
                  },
                ],
                functionCalls: [
                  {
                    id: 'notification-loop-1',
                    name: 'read_file',
                    args: { path: 'a' },
                  },
                  {
                    id: 'notification-loop-2',
                    name: 'read_file',
                    args: { path: 'b' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValue(createEmptyStream());

      await runGuardPrompt();
      // Explicit one-call cap: the notification turn's Stop-continuation
      // batch of two calls trips the per-turn cap inside
      // #runStopContinuation, pinning the graceful default at the
      // background-notification #handleStopHookLoop call site.
      mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
      mockConfig.isMaxToolCallsPerTurnExplicit = vi.fn().mockReturnValue(true);
      const callback =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

      callback('background done', '<task-notification />', {
        agentId: 'automatic-agent',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });
      expect(logLoopDetectedSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
        }),
        {},
      );
      expect(
        vi.mocked(mockClient.sessionUpdate).mock.calls.some(([params]) => {
          const update = params.update;
          return (
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text.includes('[notification error]')
          );
        }),
      ).toBe(false);
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
      const responses = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update)
        .filter(
          (update) =>
            update._meta?.['source'] === 'background_notification_response',
        );
      expect(responses).toEqual([
        expect.objectContaining({
          content: { type: 'text', text: 'Partial guarded finding.' },
          _meta: expect.objectContaining({
            backgroundTask: expect.objectContaining({ turnComplete: false }),
          }),
        }),
        expect.objectContaining({
          content: { type: 'text', text: '' },
          _meta: expect.objectContaining({
            backgroundTask: expect.objectContaining({
              turnComplete: true,
              partial: true,
            }),
          }),
        }),
      ]);
    });

    it('suspends an armed guard when a cron stream aborts', async () => {
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              prompt: string;
              cronExpr: string;
              missed?: boolean;
            }) => void,
          ) => callback({ prompt: 'scheduled work', cronExpr: '* * * * *' }),
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      const aborting = createDeferredAbortStream();
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(aborting.responseStream);

      await runGuardPrompt();
      await aborting.started;
      const internals = session as unknown as {
        cronAbortController: AbortController | null;
        cronProcessing: boolean;
        todoStopGuard: {
          blocksUnrelatedAutomaticTurns: boolean;
          observeTodoWrite(resultDisplay: unknown, allowArm: boolean): boolean;
        };
      };
      internals.todoStopGuard.observeTodoWrite(
        { type: 'todo_list', todos: pendingTodos },
        true,
      );
      expect(internals.todoStopGuard.blocksUnrelatedAutomaticTurns).toBe(true);
      internals.cronAbortController?.abort();
      aborting.abort();

      await vi.waitFor(() => {
        expect(internals.cronProcessing).toBe(false);
      });
      expect(internals.todoStopGuard.blocksUnrelatedAutomaticTurns).toBe(false);
    });

    it('treats a queued pre-prompt wakeup as part of the new baseline', async () => {
      rebuildSessionWithGuard();
      installPendingTodoTool();
      queuePendingTodoThenNaturalStops();
      const internals = session as unknown as {
        cronQueue: Array<{
          prompt: string;
          source: 'cron' | 'loop';
          taskId?: string;
        }>;
      };
      internals.cronQueue.push({
        prompt: 'old wakeup result',
        source: 'loop',
        taskId: 'old-wakeup',
      });

      await runGuardPrompt();
      await vi.waitFor(() => {
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.some(
              ([params]) => params.update._meta?.['source'] === 'loop',
            ),
        ).toBe(true);
      });

      const updates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([params]) => params.update);
      const firstGuardIndex = updates.findIndex(
        (update) => update._meta?.['source'] === 'todo_stop_guard',
      );
      const wakeupIndex = updates.findIndex(
        (update) => update._meta?.['source'] === 'loop',
      );
      expect(firstGuardIndex).toBeGreaterThanOrEqual(0);
      expect(wakeupIndex).toBeGreaterThan(firstGuardIndex);
    });

    it('defers for a wakeup created by the current work chain', async () => {
      const scheduler = {
        hasPendingWork: false,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        scheduler.list.mockReturnValue([
          { id: 'new-wakeup', cronExpr: '@wakeup' },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('drains a related wakeup before an older unrelated cron item', async () => {
      let fireCron!: (job: {
        id: string;
        prompt: string;
        cronExpr: string;
      }) => void;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              id: string;
              prompt: string;
              cronExpr: string;
            }) => void,
          ) => {
            fireCron = callback;
          },
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'blocking-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalled());
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      fireCron({
        id: 'old-unrelated-cron',
        prompt: 'old unrelated cron',
        cronExpr: '* * * * *',
      });
      await vi.waitFor(() => {
        const internals = session as unknown as {
          cronQueue: Array<{ taskId?: string }>;
        };
        expect(internals.cronQueue).toHaveLength(1);
      });
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);

      fireCron({
        id: 'related-wakeup',
        prompt: 'current-chain wakeup',
        cronExpr: '@wakeup',
      });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });

      const firstAutomaticSend = vi.mocked(mockChat.sendMessageStream).mock
        .calls[2]?.[1] as { message: Part[] };
      expect(textParts(firstAutomaticSend.message).join('\n')).toContain(
        'current-chain wakeup',
      );
      expect(textParts(firstAutomaticSend.message).join('\n')).not.toContain(
        'old unrelated cron',
      );
    });

    it('coalesces unrelated recurring cron fires while a guard is waiting', async () => {
      let fireCron!: (job: {
        id?: string;
        prompt: string;
        cronExpr?: string;
      }) => void;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              id?: string;
              prompt: string;
              cronExpr?: string;
            }) => void,
          ) => {
            fireCron = callback;
          },
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      const execute = installPendingTodoTool();
      execute.mockImplementation(async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'guard-agent',
            isBackgrounded: true,
            status: 'running',
            notified: false,
          },
        ]);
        return {
          llmContent: JSON.stringify(pendingTodos),
          returnDisplay: {
            type: 'todo_list',
            todos: pendingTodos,
            changes: {},
          },
        };
      });
      queuePendingTodoThenNaturalStops();

      await runGuardPrompt();
      expect(scheduler.start).toHaveBeenCalled();

      for (let index = 0; index < 25; index++) {
        fireCron({
          id: 'old-recurring-cron',
          prompt: 'scheduled work',
          cronExpr: '* * * * *',
        });
      }

      const internals = session as unknown as {
        cronQueue: Array<{ taskId?: string }>;
      };
      expect(internals.cronQueue).toEqual([
        expect.objectContaining({ taskId: 'old-recurring-cron' }),
      ]);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
    });

    it('coalesces recurring cron fires while FIFO priority outlives guard trust', async () => {
      let fireCron!: (job: {
        id?: string;
        prompt: string;
        cronExpr?: string;
      }) => void;
      const scheduler = {
        hasPendingWork: true,
        enableDurable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(
          (
            callback: (job: {
              id?: string;
              prompt: string;
              cronExpr?: string;
            }) => void,
          ) => {
            fireCron = callback;
          },
        ),
        stop: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      rebuildSessionWithGuard();
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
        cronQueue: Array<{ taskId?: string }>;
      };
      internals.todoStopGuardQueuedPromptPriority = true;

      session.startCronScheduler();
      await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalled());
      for (let index = 0; index < 25; index++) {
        fireCron({
          id: 'fifo-deferred-recurring-cron',
          prompt: 'scheduled work',
          cronExpr: '* * * * *',
        });
      }

      expect(internals.cronQueue).toEqual([
        expect.objectContaining({ taskId: 'fifo-deferred-recurring-cron' }),
      ]);
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    });

    it.each([
      ['related wakeup', '@wakeup', 21, 20],
      ['unrelated cron', '* * * * *', 20, 19],
    ])(
      'trims an oversized deferred cron queue before a %s arrives',
      async (_label, cronExpr, expectedTotal, expectedOld) => {
        let fireCron!: (job: {
          id: string;
          prompt: string;
          cronExpr: string;
        }) => void;
        const scheduler = {
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                cronExpr: string;
              }) => void,
            ) => {
              fireCron = callback;
            },
          ),
          stop: vi.fn(),
          list: vi.fn().mockReturnValue([]),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        rebuildSessionWithGuard();
        const internals = session as unknown as {
          todoStopGuardQueuedPromptPriority: boolean;
          cronQueue: Array<{
            prompt: string;
            source: 'cron' | 'loop';
            taskId?: string;
          }>;
        };
        internals.todoStopGuardQueuedPromptPriority = true;
        internals.cronQueue = Array.from({ length: 25 }, (_value, index) => ({
          prompt: `old unrelated ${index}`,
          source: 'cron' as const,
          taskId: `old-unrelated-${index}`,
        }));

        session.startCronScheduler();
        await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalled());
        fireCron({
          id: 'incoming',
          prompt: 'incoming work',
          cronExpr,
        });

        expect(internals.cronQueue).toHaveLength(expectedTotal);
        expect(
          internals.cronQueue.filter((item) =>
            item.taskId?.startsWith('old-unrelated-'),
          ),
        ).toHaveLength(expectedOld);
        expect(internals.cronQueue.at(-1)?.taskId).toBe('incoming');
      },
    );
  });

  describe('follow-up suggestion (daemon assist push)', () => {
    let generateMock: ReturnType<typeof vi.fn>;
    let logMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      generateMock = vi.mocked(core.generatePromptSuggestion);
      logMock = vi.mocked(core.logPromptSuggestion);
      generateMock.mockReset();
      logMock.mockReset();
      // Enable the feature by default in this describe block; individual
      // tests override `mockSettings.merged.ui` to exercise the disabled
      // path.
      (mockSettings as unknown as { merged: { ui: unknown } }).merged.ui = {
        enableFollowupSuggestions: true,
      };
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi back' }] },
      ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
    });

    it('fires prompt-suggestion extNotification after end_turn when enabled', async () => {
      generateMock.mockResolvedValue({ suggestion: 'Run the tests next?' });
      vi.mocked(mockChat.getHistoryTail).mockClear();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      await vi.waitFor(() => {
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          'qwen/notify/session/prompt-suggestion',
          {
            v: 1,
            sessionId: 'test-session-id',
            suggestion: 'Run the tests next?',
            promptId: 'test-session-id########1',
          },
        );
      });

      // Pin the curated-history tail: a revert to `chat.getHistory(true)`
      // (full structuredClone per end_turn, the #4624 heap-peak shape) or a
      // dropped curated argument (`getHistoryTail(40)` defaults
      // curated=false) must not pass silently (#9233).
      expect(vi.mocked(mockChat.getHistoryTail)).toHaveBeenCalledWith(40, true);

      // The generator received an AbortSignal so the daemon can cancel
      // mid-flight if the next prompt arrives first. `merged.ui` above leaves
      // `enableCacheSharing` UNSET, so the gate must honour the schema's
      // declared `default: true` — `mergeSettings` never applies schema
      // defaults, and gating on `=== true` turned the cache-aware fork into
      // dead code unless the user explicitly set the flag (#9230).
      expect(generateMock).toHaveBeenCalledWith(
        mockConfig,
        expect.any(Array),
        expect.any(AbortSignal),
        expect.objectContaining({ enableCacheSharing: true }),
      );
    });

    it('forwards an explicit enableCacheSharing=false opt-out', async () => {
      (mockSettings as unknown as { merged: { ui: unknown } }).merged.ui = {
        enableFollowupSuggestions: true,
        enableCacheSharing: false,
      };
      generateMock.mockResolvedValue({ suggestion: null });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      await vi.waitFor(() => expect(generateMock).toHaveBeenCalled());
      expect(generateMock).toHaveBeenCalledWith(
        mockConfig,
        expect.any(Array),
        expect.any(AbortSignal),
        expect.objectContaining({ enableCacheSharing: false }),
      );
    });

    it('does not emit when the feature is disabled', async () => {
      (mockSettings as unknown as { merged: { ui: unknown } }).merged.ui = {
        enableFollowupSuggestions: false,
      };

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      // Give the (skipped) IIFE a chance to run.
      await new Promise((r) => setTimeout(r, 10));
      expect(generateMock).not.toHaveBeenCalled();
      expect(
        (
          mockClient.extNotification as ReturnType<typeof vi.fn>
        ).mock.calls.find(
          ([method]) => method === 'qwen/notify/session/prompt-suggestion',
        ),
      ).toBeUndefined();
    });

    it('emits when the setting is unset (on by default)', async () => {
      // Regression for #5145 review: the schema default isn't applied by
      // mergeSettings, so an unset value must be treated as enabled — only an
      // explicit `false` opts out.
      (mockSettings as unknown as { merged: { ui: unknown } }).merged.ui = {};
      generateMock.mockResolvedValue({ suggestion: 'Run the tests next?' });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      await vi.waitFor(() => {
        expect(generateMock).toHaveBeenCalled();
      });
    });

    it('does not emit in PLAN approval mode', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      generateMock.mockResolvedValue({ suggestion: 'something' });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(generateMock).not.toHaveBeenCalled();
    });

    it('logs filterReason via PromptSuggestionEvent when generation is suppressed', async () => {
      generateMock.mockResolvedValue({
        suggestion: null,
        filterReason: 'meta',
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      await vi.waitFor(() => {
        expect(logMock).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({ outcome: 'suppressed', reason: 'meta' }),
        );
      });
      // No extNotification when suggestion is filtered.
      expect(
        (
          mockClient.extNotification as ReturnType<typeof vi.fn>
        ).mock.calls.find(
          ([method]) => method === 'qwen/notify/session/prompt-suggestion',
        ),
      ).toBeUndefined();
    });

    it('aborts the in-flight generator when a new prompt arrives', async () => {
      let capturedSignal: AbortSignal | undefined;
      generateMock
        .mockImplementationOnce(
          async (
            _config: unknown,
            _history: unknown,
            signal: AbortSignal,
          ): Promise<{ suggestion: string | null }> => {
            capturedSignal = signal;
            return new Promise((resolve) => {
              signal.addEventListener('abort', () =>
                resolve({ suggestion: null }),
              );
            });
          },
        )
        .mockResolvedValue({ suggestion: null });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'first' }],
      });
      // Wait for the IIFE to actually call generateMock and capture the
      // signal — without this, the second prompt can race past the
      // first IIFE's microtask.
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());
      expect(capturedSignal!.aborted).toBe(false);

      // Send a second prompt. The followupAbort on the first turn
      // should fire synchronously at the top of `prompt()`.
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'second' }],
      });

      expect(capturedSignal!.aborted).toBe(true);
    });

    it('aborts the in-flight generator when cancelPendingPrompt is called', async () => {
      let capturedSignal: AbortSignal | undefined;
      generateMock
        .mockImplementationOnce(
          async (
            _config: unknown,
            _history: unknown,
            signal: AbortSignal,
          ): Promise<{ suggestion: string | null }> => {
            capturedSignal = signal;
            return new Promise((resolve) => {
              signal.addEventListener('abort', () =>
                resolve({ suggestion: null }),
              );
            });
          },
        )
        .mockResolvedValue({ suggestion: null });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'go' }],
      });
      await vi.waitFor(() => expect(capturedSignal).toBeDefined());

      // followupAbort cleanup now runs unconditionally before the
      // prompt/cron guard — inject a fake pendingPrompt so the call
      // doesn't throw, but the real assertion is the signal abort.
      (session as unknown as { pendingPrompt: AbortController }).pendingPrompt =
        new AbortController();

      await session.cancelPendingPrompt();
      expect(capturedSignal!.aborted).toBe(true);
    });
  });
});

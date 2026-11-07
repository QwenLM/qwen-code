/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeInitialTurnFromHistory,
  resolveExistingFile,
  Session,
} from './Session.js';
import {
  getStartupContextLength,
  markCompressedHistory,
} from '@qwen-code/qwen-code-core/core/environmentContext.js';
import { detectTurnInterruption } from '@qwen-code/qwen-code-core/core/turn-interruption.js';
import { FinishReason } from '@qwen-code/qwen-code-core/core/genai-compat.js';
import { markToolCallArgumentsIncomplete } from '@qwen-code/qwen-code-core/core/incomplete-tool-call-args.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type { Content, FunctionCall, Part } from '@google/genai';
import type {
  ChatRecord,
  Config,
  ContentGeneratorConfig,
  LlmChat,
  ProviderModelConfig,
  RequestLifecycleEvent,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  AuthType,
  ModelsConfig,
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import { ExitPlanModeTool } from '@qwen-code/qwen-code-core/tools/exitPlanMode.js';
import { SettingScope } from '../../config/settings.js';
import * as settingsModule from '../../config/settings.js';
import type {
  AgentSideConnection,
  PromptRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';
import { CommandKind } from '../../ui/commands/types.js';
import { buildAcpModelOptions } from '../../utils/acpModelUtils.js';
import {
  CHANNEL_OUTPUT_MODE_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_TASK_OUTPUT_META_KEY,
  CHANNEL_TASK_RESULT_META_KEY,
} from '@qwen-code/channel-base';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import { DAEMON_INPUT_ANNOTATIONS_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import { CAPTURE_SCREEN_CONTEXT_TOOL_NAME } from '../live/capture-screen-context.js';
import { SPEAK_TO_USER_TOOL_NAME } from '../live/live-speak-to-user.js';
import {
  collectHistoryReplayUpdates,
  createReplayCumulativeUsage,
} from './history-replay-page.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());
const readActualSettingsSnapshot = settingsModule.readSettingsSnapshot;
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

describe('computeInitialTurnFromHistory', () => {
  it('uses the largest numeric prompt id suffix for the current session', () => {
    expect(
      computeInitialTurnFromHistory(
        [
          chatRecord({
            uuid: 'user-1',
            promptId: 'test-session-id########1',
            message: { parts: [{ text: '1' }] },
          }),
          chatRecord({
            uuid: 'system-1',
            timestamp: '2026-05-17T07:27:23.470Z',
            type: 'system',
            subtype: 'ui_telemetry',
            systemPayload: {
              uiEvent: {
                prompt_id: 'test-session-id########2',
              },
            },
          }),
          chatRecord({
            uuid: 'system-notification',
            timestamp: '2026-05-17T07:27:24.000Z',
            type: 'system',
            subtype: 'ui_telemetry',
            systemPayload: {
              uiEvent: {
                prompt_id: 'test-session-id########notification123',
              },
            },
          }),
          chatRecord({
            uuid: 'other-session',
            sessionId: 'other-session-id',
            timestamp: '2026-05-17T07:27:25.000Z',
            promptId: 'other-session-id########99',
            message: { parts: [{ text: 'other' }] },
          }),
        ],
        'test-session-id',
      ),
    ).toBe(2);
  });

  it('falls back to user message count when prompt ids are absent', () => {
    expect(
      computeInitialTurnFromHistory(
        [
          chatRecord({
            uuid: 'user-1',
            message: { parts: [{ text: '1' }] },
          }),
          chatRecord({
            uuid: 'assistant-1',
            timestamp: '2026-05-17T07:27:18.861Z',
            type: 'assistant',
            message: { parts: [{ text: 'answer 1' }] },
          }),
          chatRecord({
            uuid: 'realtime-user',
            timestamp: '2026-05-17T07:27:19.000Z',
            subtype: 'realtime_message',
            message: { parts: [{ text: 'voice question' }] },
          }),
          chatRecord({
            uuid: 'user-2',
            timestamp: '2026-05-17T07:27:20.446Z',
            message: { parts: [{ text: '2' }] },
          }),
          chatRecord({
            uuid: 'other-session',
            sessionId: 'other-session-id',
            timestamp: '2026-05-17T07:27:25.000Z',
            message: { parts: [{ text: 'other' }] },
          }),
        ],
        'test-session-id',
      ),
    ).toBe(2);
  });
});

describe('resolveExistingFile', () => {
  it('returns undefined when the path does not exist', () => {
    expect(
      resolveExistingFile('/tmp/missing.png', () => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });

  it('returns undefined when the path is not a file or directory', () => {
    expect(
      resolveExistingFile(
        '/tmp/dir',
        (resolved) => resolved,
        () => ({ isFile: () => false, isDirectory: () => false }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when stat fails after resolution succeeds', () => {
    expect(
      resolveExistingFile(
        '/tmp/image.png',
        (resolved) => resolved,
        () => {
          throw new Error('EACCES');
        },
      ),
    ).toBeUndefined();
  });

  it('returns the canonical path for an existing file', () => {
    expect(
      resolveExistingFile(
        '/tmp/alias.png',
        () => '/tmp/image.png',
        () => ({ isFile: () => true }),
      ),
    ).toBe('/tmp/image.png');
  });

  it('returns the canonical path for an existing directory', () => {
    expect(
      resolveExistingFile(
        '/tmp/alias',
        () => '/tmp/dir',
        () => ({ isFile: () => false, isDirectory: () => true }),
      ),
    ).toBe('/tmp/dir');
  });
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
  let approvalModeChangeListener:
    | ((mode: ApprovalMode, prePlanMode: ApprovalMode | undefined) => void)
    | undefined;
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
    approvalModeChangeListener = undefined;
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
      onApprovalModeChange: vi.fn(
        (
          listener: (
            mode: ApprovalMode,
            prePlanMode: ApprovalMode | undefined,
          ) => void,
        ) => {
          approvalModeChangeListener = listener;
          return unsubscribeApprovalModeChange;
        },
      ),
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

  describe('session agent records', () => {
    const request = {
      kind: 'agent_message' as const,
      recordKey: 'run-1:result',
      modelText: '<agent_message from="claude-B">done</agent_message>',
      payload: {
        displayText: 'done',
        author: { agentId: 'agent-1', name: 'claude-B' },
        runId: 'run-1',
        status: 'completed' as const,
      },
    };

    it('writes once per recordKey, shows it live, and starts no turn', async () => {
      type Written = { uuid: string; timestamp: string; created: boolean };
      let finishWrite!: (written: Written) => void;
      mockChatRecordingService.recordExternalAgentRecordStrict.mockImplementationOnce(
        () =>
          new Promise<Written>((resolve) => {
            finishWrite = resolve;
          }),
      );

      const first = session.appendExternalRecord(request);
      // A retry while the first write is still in flight must not write.
      const retry = session.appendExternalRecord(request);
      await vi.waitFor(() =>
        expect(
          mockChatRecordingService.recordExternalAgentRecordStrict,
        ).toHaveBeenCalled(),
      );
      finishWrite({
        uuid: 'record-1',
        timestamp: '2026-10-06T01:02:03.000Z',
        created: true,
      });
      await expect(first).resolves.toEqual({
        recordId: 'record-1',
        created: true,
      });
      await expect(retry).resolves.toEqual({
        recordId: 'record-1',
        created: false,
      });
      await expect(session.appendExternalRecord(request)).resolves.toEqual({
        recordId: 'record-1',
        created: false,
      });

      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).toHaveBeenCalledOnce();
      const agentUpdates = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([notification]) => notification.update)
        .filter((update) => update._meta?.['qwenAgentMessage'] !== undefined);
      expect(agentUpdates).toHaveLength(1);
      expect(agentUpdates[0]).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done' },
        _meta: {
          qwenDiscreteMessage: true,
          qwenAgentMessage: { kind: 'agent_message', runId: 'run-1' },
          qwenTranscript: {
            segmentId: 'agent:run-1',
            sourceRecordIds: ['record-1'],
          },
          // The record's own timestamp, as replay projects it.
          timestamp: Date.parse('2026-10-06T01:02:03.000Z'),
        },
      });
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(session.pendingExternalAgentContext).toEqual([request.modelText]);
    });

    it('returns a record already in the transcript, even mid-turn', async () => {
      // A restarted child: nothing in memory, the record is on disk.
      mockChatRecordingService.findExternalAgentRecord.mockResolvedValueOnce({
        uuid: 'record-0',
        timestamp: '2026-10-06T00:00:00.000Z',
      });
      vi.spyOn(session, 'isTurnIdle').mockReturnValue(false);

      await expect(session.appendExternalRecord(request)).resolves.toEqual({
        recordId: 'record-0',
        created: false,
      });
      // Remembered: the next repeat does not consult the transcript again.
      await expect(session.appendExternalRecord(request)).resolves.toEqual({
        recordId: 'record-0',
        created: false,
      });
      expect(
        mockChatRecordingService.findExternalAgentRecord,
      ).toHaveBeenCalledOnce();
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).not.toHaveBeenCalled();
      expect(session.pendingExternalAgentContext).toEqual([]);
      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.some(
            ([notification]) =>
              notification.update._meta?.['qwenAgentMessage'] !== undefined,
          ),
      ).toBe(false);
    });

    it('defers once per key mid-turn and writes the queue on close', async () => {
      const idle = vi.spyOn(session, 'isTurnIdle').mockReturnValue(false);
      const deferred = { recordId: '', created: true, deferred: true };
      await expect(session.appendExternalRecord(request)).resolves.toEqual(
        deferred,
      );
      await expect(session.appendExternalRecord(request)).resolves.toEqual(
        deferred,
      );
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).not.toHaveBeenCalled();

      // The close path: turns settled, the recorder still open.
      session.beginClose();
      idle.mockRestore();
      await session.flushDeferredExternalRecords();
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).toHaveBeenCalledOnce();
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).toHaveBeenCalledWith(request);
      // Nothing is shown or queued for a session that is going away.
      expect(session.pendingExternalAgentContext).toEqual([]);

      // Written: a re-send now gets the record id back without a write.
      await expect(session.appendExternalRecord(request)).resolves.toEqual({
        recordId: 'record-1',
        created: false,
      });
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).toHaveBeenCalledOnce();
    });

    it('keeps send order when a record arrives behind a deferred one', async () => {
      const idle = vi.spyOn(session, 'isTurnIdle').mockReturnValue(false);
      await session.appendExternalRecord(request);
      // The turn settles before the queue drains; a later record must queue
      // behind the earlier one instead of being written first.
      idle.mockReturnValue(true);
      const later = { ...request, recordKey: 'run-2:result' };
      await expect(session.appendExternalRecord(later)).resolves.toEqual({
        recordId: '',
        created: true,
        deferred: true,
      });
      await vi.waitFor(() =>
        expect(
          mockChatRecordingService.recordExternalAgentRecordStrict,
        ).toHaveBeenCalledTimes(2),
      );
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict.mock.calls.map(
          (call) => (call[0] as { recordKey: string }).recordKey,
        ),
      ).toEqual(['run-1:result', 'run-2:result']);
    });

    it('drops deferred records it cannot write on close', async () => {
      vi.spyOn(session, 'isTurnIdle').mockReturnValue(false);
      await session.appendExternalRecord(request);
      mockChatRecordingService.recordExternalAgentRecordStrict.mockRejectedValueOnce(
        new Error('writer closed'),
      );
      await expect(
        session.flushDeferredExternalRecords(),
      ).resolves.toBeUndefined();
      // The queue is empty afterwards: a second flush writes nothing.
      await session.flushDeferredExternalRecords();
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).toHaveBeenCalledOnce();
    });

    it('refuses to write once the session is closing', async () => {
      session.dispose();
      await expect(session.appendExternalRecord(request)).rejects.toThrow(
        /closing/,
      );
      expect(
        mockChatRecordingService.recordExternalAgentRecordStrict,
      ).not.toHaveBeenCalled();
    });
  });

  describe('MCP App tools', () => {
    const request = {
      serverName: 'tableau',
      resourceUri: 'ui://tableau/app',
      name: 'get-embed-token',
      arguments: {},
    };
    function installAppTool() {
      const raw = {
        content: [{ type: 'text', text: '{"token":"APP_PRIVATE_TOKEN"}' }],
        _meta: { secret: 'APP_PRIVATE_TOKEN' },
        structuredContent: { token: 'APP_PRIVATE_TOKEN' },
      };
      const callTool = vi.fn().mockResolvedValue(raw);
      const tool = new core.DiscoveredMCPTool(
        { tool: async () => ({}), callTool: async () => [] },
        'tableau',
        'get-embed-token',
        'Get embed token',
        { type: 'object', properties: {} },
        false,
        undefined,
        mockConfig,
        { callTool },
      );
      const registry = Object.assign(mockToolRegistry, {
        hasMcpAppResource: vi.fn(
          (server: string, uri: string) =>
            server === request.serverName && uri === request.resourceUri,
        ),
        getMcpAppTool: vi.fn((server: string, name: string) =>
          server === request.serverName && name === request.name
            ? tool
            : undefined,
        ),
      });
      return { raw, callTool, tool, registry };
    }

    it('requests permission and returns raw data only to the App', async () => {
      const { raw, callTool, tool } = installAppTool();
      const buildForApp = vi.spyOn(tool, 'buildForApp');
      await expect(
        session.callMcpAppTool('mcp-app-1', request),
      ).resolves.toEqual(raw);
      expect(buildForApp).toHaveBeenCalledWith(
        request.arguments,
        expect.any(Function),
        mockConfig,
      );
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(callTool).toHaveBeenCalledOnce();
      expect(
        JSON.stringify(vi.mocked(mockClient.sessionUpdate).mock.calls),
      ).not.toContain('APP_PRIVATE_TOKEN');
      expect(
        JSON.stringify(mockChatRecordingService.recordToolResult.mock.calls),
      ).not.toContain('APP_PRIVATE_TOKEN');
      expect(mockChat.addHistory).not.toHaveBeenCalled();
    });

    it('does not execute when permission is cancelled', async () => {
      const { callTool } = installAppTool();
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
      });
      expect(await session.callMcpAppTool('mcp-app-2', request)).toMatchObject({
        isError: true,
      });
      expect(callTool).not.toHaveBeenCalled();
    });

    it('keeps PreToolUse context out of the App error result', async () => {
      const { callTool } = installAppTool();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({
        request: vi.fn().mockImplementation(async () => ({
          success: true,
          output: {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'blocked by probe',
              additionalContext: 'APP_HOOK_MARKER',
            },
          },
        })),
      });
      mockConfig.getTruncateToolOutputThreshold = vi
        .fn()
        .mockReturnValue(25_000);

      expect(await session.callMcpAppTool('mcp-app-hook', request)).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'blocked by probe' }],
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    });

    it('honors explicit permission deny before YOLO and rejects unknown origins and targets', async () => {
      const { callTool } = installAppTool();
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.YOLO);
      vi.mocked(mockConfig.getPermissionManager).mockReturnValue({
        isToolEnabled: async () => true,
        hasRelevantRules: () => true,
        evaluate: async () => 'deny',
        findMatchingDenyRule: () => 'mcp__tableau__get-embed-token',
      } as unknown as ReturnType<Config['getPermissionManager']>);
      expect(
        await session.callMcpAppTool('mcp-app-deny', request),
      ).toMatchObject({ isError: true });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      await expect(
        session.callMcpAppTool('mcp-app-server', {
          ...request,
          serverName: 'other',
        }),
      ).rejects.toThrow('resource');
      await expect(
        session.callMcpAppTool('mcp-app-resource', {
          ...request,
          resourceUri: 'ui://other',
        }),
      ).rejects.toThrow('resource');
      await expect(
        session.callMcpAppTool('mcp-app-target', { ...request, name: 'shell' }),
      ).rejects.toThrow('tool');
      expect(callTool).not.toHaveBeenCalled();
    });

    it.each(['dispose', 'cancelMcpAppCalls'] as const)(
      'preserves a pending App across a reversible close gate until %s',
      async (cancel) => {
        const { callTool } = installAppTool();
        vi.mocked(mockClient.requestPermission).mockReturnValue(
          new Promise(() => {}),
        );
        const pending = session.callMcpAppTool('mcp-app-close', request);
        const rejected = pending.catch((error: unknown) => error);
        await vi.waitFor(() =>
          expect(mockClient.requestPermission).toHaveBeenCalledOnce(),
        );
        expect(session.isTurnIdle()).toBe(false);
        expect(session.collectActiveWorkHolds()).toContainEqual({
          category: 'session',
          id: 'session:active-turn',
        });
        expect(() => session.beginHistoryMutation()).toThrow('busy');
        let settled = false;
        void rejected.then(() => {
          settled = true;
        });
        const release = session.beginClose();
        release();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(session.isTurnIdle()).toBe(false);
        session[cancel]();
        expect(await rejected).toBeInstanceOf(Error);
        expect(callTool).not.toHaveBeenCalled();
        expect(session.isTurnIdle()).toBe(cancel === 'cancelMcpAppCalls');
      },
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

  describe('session Workflow mode', () => {
    it.each(['throw', 'no stream'])(
      'restores the original Retry entry when setup returns %s before pushing',
      async (failure) => {
        const orphan: Content = {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nWorkflow mode is off for this session. Original guidance.\n</system-reminder>',
            },
            { text: 'retry me' },
          ],
        };
        vi.mocked(mockChat.stripOrphanedUserEntriesFromHistory).mockReturnValue(
          [orphan],
        );
        if (failure === 'throw') {
          vi.mocked(mockChat.sendMessageStream).mockRejectedValueOnce(
            new Error('setup before push'),
          );
        } else {
          vi.mocked(mockChat.sendMessageStream).mockResolvedValueOnce(
            null as unknown as AsyncGenerator<core.StreamEvent>,
          );
        }
        const attempt = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'retry me' }],
          _meta: { 'qwen.daemon.retry': true },
        });
        if (failure === 'throw')
          await expect(attempt).rejects.toThrow('setup before push');
        else
          await expect(attempt).resolves.toMatchObject({
            stopReason: 'end_turn',
          });
        expect(mockChat.addHistory).toHaveBeenCalledExactlyOnceWith(orphan);
      },
    );

    it('keeps the original envelope when a hook blocks Retry before the next retry', async () => {
      const reminder =
        '<system-reminder>\nWorkflow mode is enabled for this session. Original guidance.\n</system-reminder>';
      const orphan: Content = {
        role: 'user',
        parts: [{ text: reminder }, { text: 'retry me' }],
      };
      const history = [orphan];
      let pushes = 0;
      Object.assign(mockChat, {
        getUserContentPushCount: vi.fn(() => pushes),
        stripOrphanedUserEntriesFromHistory: vi.fn(() => history.splice(0)),
        addHistory: vi.fn((entry: Content) => history.push(entry)),
      });
      const messageBus = {
        request: vi
          .fn()
          .mockResolvedValueOnce({
            success: true,
            output: { decision: 'block', reason: 'Retry paused by hook' },
          })
          .mockResolvedValue({ success: true, output: {} }),
      };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn(() => false);
      mockConfig.hasHooksForEvent = vi.fn(
        (event) => event === 'UserPromptSubmit',
      );
      mockConfig.prepareWorkflowMode = vi.fn();
      const prompt = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text' as const, text: 'retry me' }],
        _meta: { 'qwen.daemon.retry': true },
      };

      await session.prompt(prompt);
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(history).toEqual([orphan]);
      vi.mocked(mockChat.addHistory).mockClear();
      vi.mocked(mockChat.sendMessageStream).mockImplementation(async () => {
        pushes++;
        return createEmptyStream();
      });
      await session.prompt(prompt);
      expect(
        textParts(firstSentMessage()).filter((text) => text === reminder),
      ).toHaveLength(1);
      expect(mockConfig.prepareWorkflowMode).not.toHaveBeenCalled();
      expect(mockChat.addHistory).not.toHaveBeenCalled();
    });

    it.each([
      'is enabled for this session',
      'remains enabled for this session',
      'is off for this session',
      'is temporarily unavailable',
    ])(
      'replays the original %s envelope on Retry without preparing a new turn',
      async (state) => {
        const reminder = `<system-reminder>\nWorkflow mode ${state}. Original turn guidance.\n</system-reminder>`;
        const commit = vi.fn();
        mockConfig.prepareWorkflowMode = vi.fn(() => ({
          reminder,
          onModelRequestDispatched: commit,
        }));
        vi.mocked(mockChat.sendMessageStream).mockImplementation(async () =>
          createEmptyStream(),
        );
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'ordinary request' }],
        });
        const originalParts = firstSentMessage();
        vi.mocked(
          mockChat.sendMessageStream,
        ).mock.calls[0]?.[4]?.onModelRequestDispatched?.();
        expect(commit).toHaveBeenCalledOnce();
        vi.mocked(mockChat.stripOrphanedUserEntriesFromHistory).mockReturnValue(
          [{ role: 'user', parts: originalParts }],
        );
        vi.mocked(mockChat.sendMessageStream).mockClear();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'ordinary request' }],
          _meta: { 'qwen.daemon.retry': true },
        });

        expect(
          textParts(firstSentMessage()).filter((text) => text === reminder),
        ).toHaveLength(1);
        expect(mockConfig.prepareWorkflowMode).toHaveBeenCalledOnce();
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[0]?.[4]
            ?.onModelRequestDispatched,
        ).toBeUndefined();
      },
    );

    it('prepares mode for an ordinary unknown-origin ACP request and forwards only the dispatch token', async () => {
      const commit = vi.fn();
      mockConfig.prepareWorkflowMode = vi.fn(() => ({
        reminder: '<system-reminder>MODE_SENTINEL</system-reminder>',
        onModelRequestDispatched: commit,
      }));
      vi.mocked(mockChat.sendMessageStream).mockImplementation(async () =>
        createEmptyStream(),
      );
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ordinary request' }],
      });
      expect(mockConfig.prepareWorkflowMode).toHaveBeenCalledExactlyOnceWith(
        null,
      );
      expect(
        textParts(firstSentMessage()).filter((text) =>
          text.includes('MODE_SENTINEL'),
        ),
      ).toHaveLength(1);
      expect(
        vi.mocked(mockChat.sendMessageStream).mock.calls[0]?.[4]
          ?.onModelRequestDispatched,
      ).toBe(commit);
      expect(commit).not.toHaveBeenCalled();
    });

    it.each([
      { 'qwen.daemon.retry': true },
      { [CHANNEL_PROMPT_META_KEY]: true },
      { 'qwen.daemon.submittedPrompt': '/summary task' },
    ])(
      'does not prepare mode for an ineligible ACP request %j',
      async (meta) => {
        mockConfig.prepareWorkflowMode = vi.fn(() => ({
          reminder: 'MODE_SENTINEL',
        }));
        vi.mocked(mockChat.sendMessageStream).mockImplementation(async () =>
          createEmptyStream(),
        );
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'expanded ordinary request' }],
          _meta: meta,
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalled();
        expect(mockConfig.prepareWorkflowMode).not.toHaveBeenCalled();
        expect(textParts(firstSentMessage()).join('')).not.toContain(
          'MODE_SENTINEL',
        );
      },
    );

    it('publishes the full committed option snapshot and drops queued updates after disposal', async () => {
      let changed!: () => void;
      const unsubscribe = vi.fn();
      mockConfig.onWorkflowModeChange = vi.fn((listener) => {
        changed = () =>
          listener({ requested: true, available: true, effective: true });
        return unsubscribe;
      });
      const configOptions = [
        {
          id: 'workflow_mode',
          name: 'Workflow mode',
          type: 'select' as const,
          currentValue: 'on',
          options: [{ value: 'on', name: 'On' }],
        },
      ];
      session.bindWorkflowModeUpdates(
        () => configOptions,
        () => true,
      );
      changed();
      await vi.waitFor(() =>
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: { sessionUpdate: 'config_option_update', configOptions },
        }),
      );
      vi.mocked(mockClient.sessionUpdate).mockClear();
      changed();
      session.dispose();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
  });

  describe('single-turn workflow intent', () => {
    beforeEach(() => {
      vi.spyOn(settingsModule, 'readSettingsSnapshot').mockReturnValue(
        mockSettings,
      );
      mockConfig.isWorkflowsEnabled = vi.fn().mockReturnValue(true);
      let keywordEnabled = true;
      mockConfig.getWorkflowKeywordTriggerEnabled = vi.fn(() => keywordEnabled);
      mockConfig.setWorkflowKeywordTriggerEnabled = vi.fn(
        (enabled: boolean) => {
          keywordEnabled = enabled;
        },
      );
      mockConfig.storage.getProjectRoot = vi.fn().mockReturnValue('/repo');
      mockConfig.isWorkflowNameOnly = vi.fn().mockReturnValue(true);
      mockToolRegistry.getAllToolNames.mockReturnValue([
        core.ToolNames.WORKFLOW,
      ]);
      vi.mocked(mockChat.sendMessageStream).mockImplementation(async () =>
        createEmptyStream(),
      );
    });

    function intentParts(parts: Part[]): string[] {
      return textParts(parts).filter((text) =>
        text.includes('This session runs named workflows only'),
      );
    }

    it('injects one model-only reminder from declared raw text and does not inherit it', async () => {
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'expanded request without a keyword' }],
        _meta: { 'qwen.daemon.submittedPrompt': 'ultracode workflow audit' },
      });

      expect(intentParts(firstSentMessage())).toHaveLength(1);
      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'expanded request without a keyword',
        undefined,
        undefined,
        expect.any(String),
        undefined,
      );

      vi.mocked(mockChat.sendMessageStream).mockClear();
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode unknown' }],
      });

      expect(intentParts(firstSentMessage())).toHaveLength(0);
    });

    it.each([
      { name: 'missing declaration', meta: {} },
      {
        name: 'blank declaration',
        meta: { 'qwen.daemon.submittedPrompt': '  ' },
      },
      {
        name: 'invalid declaration',
        meta: { 'qwen.daemon.submittedPrompt': { text: 'ultracode' } },
      },
      {
        name: 'derived keyword',
        meta: { 'qwen.daemon.submittedPrompt': 'inspect this file' },
      },
      {
        name: 'slash declaration with expanded request',
        meta: { 'qwen.daemon.submittedPrompt': '/summary workflow' },
      },
      {
        name: 'retry',
        meta: {
          'qwen.daemon.submittedPrompt': 'ultracode',
          'qwen.daemon.retry': true,
        },
      },
      {
        name: 'channel',
        meta: {
          'qwen.daemon.submittedPrompt': 'ultracode',
          [CHANNEL_PROMPT_META_KEY]: true,
        },
      },
    ])('does not inject for $name', async ({ meta }) => {
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode from expanded context' }],
        _meta: meta,
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
      expect(intentParts(firstSentMessage())).toHaveLength(0);
    });

    it('applies the live opt-out on the next declared turn', async () => {
      mockSettings.merged.ui = { disableWorkflowKeywordTrigger: true };

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode' }],
        _meta: { 'qwen.daemon.submittedPrompt': 'ultracode' },
      });

      expect(intentParts(firstSentMessage())).toHaveLength(0);
    });

    it('keeps ordinary prompting available when the setting snapshot cannot be read', async () => {
      vi.mocked(settingsModule.readSettingsSnapshot).mockImplementation(() => {
        throw new Error('unreadable workspace settings');
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode' }],
        _meta: { 'qwen.daemon.submittedPrompt': 'ultracode' },
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
      expect(intentParts(firstSentMessage())).toHaveLength(0);
      expect(mockConfig.getWorkflowKeywordTriggerEnabled()).toBe(false);
    });

    async function withLiveSettings(
      test: (root: string, userFile: string) => Promise<void>,
    ) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dw03-settings-'));
      const home = path.join(root, 'home');
      const systemFile = path.join(root, 'system.json');
      await fs.mkdir(home);
      await fs.writeFile(systemFile, '{}');
      vi.stubEnv('QWEN_HOME', home);
      vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', systemFile);
      vi.stubEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', systemFile);
      vi.mocked(settingsModule.readSettingsSnapshot).mockImplementation(
        readActualSettingsSnapshot,
      );
      try {
        await test(root, path.join(home, 'settings.json'));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }

    async function currentIntentCount() {
      vi.mocked(mockChat.sendMessageStream).mockClear();
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode' }],
        _meta: { 'qwen.daemon.submittedPrompt': 'ultracode' },
      });
      expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
      return intentParts(firstSentMessage()).length;
    }

    it('reads normal persisted opt-out writes on the next turn without reloading the session', async () => {
      await withLiveSettings(async (root, userFile) => {
        const workspace = path.join(root, 'workspace');
        await fs.mkdir(workspace);
        vi.mocked(mockConfig.storage.getProjectRoot).mockReturnValue(workspace);
        const counts = [];
        for (const disabled of [false, true, false]) {
          await fs.writeFile(
            userFile,
            JSON.stringify({ ui: { disableWorkflowKeywordTrigger: disabled } }),
          );
          counts.push(await currentIntentCount());
        }
        expect(counts).toEqual([1, 0, 1]);
        expect(mockSettings.reloadScopeFromDisk).not.toHaveBeenCalled();
      });
    });

    it('uses the admission workspace and its current trust rather than the live cwd', async () => {
      await withLiveSettings(async (root, userFile) => {
        const first = path.join(root, 'first');
        const second = path.join(root, 'second');
        await Promise.all(
          [first, second].map((workspace) =>
            fs.mkdir(path.join(workspace, '.qwen'), { recursive: true }),
          ),
        );
        await fs.writeFile(
          userFile,
          JSON.stringify({ ui: { disableWorkflowKeywordTrigger: true } }),
        );
        await fs.writeFile(
          path.join(first, '.qwen/settings.json'),
          JSON.stringify({ ui: { disableWorkflowKeywordTrigger: false } }),
        );
        await fs.writeFile(
          path.join(second, '.qwen/settings.json'),
          JSON.stringify({ ui: { disableWorkflowKeywordTrigger: true } }),
        );
        vi.mocked(mockConfig.getProjectRoot).mockReturnValue(second);
        vi.mocked(mockConfig.storage.getProjectRoot).mockReturnValue(first);
        expect(await currentIntentCount()).toBe(1);
        vi.mocked(mockConfig.storage.getProjectRoot).mockReturnValue(second);
        expect(await currentIntentCount()).toBe(0);
        vi.mocked(mockConfig.storage.getProjectRoot).mockReturnValue(first);
        vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
        expect(await currentIntentCount()).toBe(0);
      });
    });

    it('does not create a model request when an eligible prompt is blocked by a hook', async () => {
      const request = vi.fn().mockResolvedValue({
        success: true,
        output: { decision: 'block', reason: 'blocked' },
      });
      mockConfig.getMessageBus = vi.fn().mockReturnValue({ request });
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi.fn(
        (name) => name === 'UserPromptSubmit',
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'ultracode' }],
        _meta: { 'qwen.daemon.submittedPrompt': 'ultracode' },
      });

      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'UserPromptSubmit',
          input: { prompt: 'ultracode', submitted_prompt: 'ultracode' },
        }),
        expect.anything(),
      );
    });
  });

  it('captures the Session Workflow gate from settings at construction instead of tracking the live view', () => {
    const setSessionWorkflowEnabledProvider = vi.fn();
    const merged: Record<string, unknown> = {
      experimental: { sessionWorkflow: true },
    };
    const gateSettings = {
      get merged() {
        return merged;
      },
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
      reloadScopeFromDisk: vi.fn(() => {
        merged['experimental'] = { sessionWorkflow: false };
      }),
    } as unknown as LoadedSettings;
    const gateConfig = {
      ...mockConfig,
      setSessionWorkflowEnabledProvider,
    } as unknown as Config;

    const gateSession = new Session(
      'gate-session-id',
      gateConfig,
      mockClient,
      gateSettings,
    );

    const provider = setSessionWorkflowEnabledProvider.mock.calls.at(-1)?.[0];
    expect(provider).toBeDefined();
    expect(provider?.()).toBe(true);

    // reloadSkillSettings (the reload a workspaceSkillsRefresh performs on
    // every live session) swaps the session's own workspace view; the gate
    // must not silently flip with no change event and no plan-revision
    // cleanup — gate changes flow through the daemon's explicit writers.
    gateSession.reloadSkillSettings();
    expect(
      (merged['experimental'] as Record<string, unknown>)['sessionWorkflow'],
    ).toBe(false);
    expect(provider?.()).toBe(true);
  });

  it('does not create approval transcript state during construction', () => {
    expect(
      mockChatRecordingService.recordSessionApprovalMode,
    ).not.toHaveBeenCalled();
  });

  it('records approval changes and unsubscribes on dispose', () => {
    vi.mocked(mockConfig.getPlanExecutionMode).mockReturnValue(
      ApprovalMode.AUTO_EDIT,
    );
    approvalModeChangeListener?.(ApprovalMode.PLAN, ApprovalMode.YOLO);

    expect(
      mockChatRecordingService.recordSessionApprovalMode,
    ).toHaveBeenCalledWith({
      mode: ApprovalMode.PLAN,
      prePlanMode: ApprovalMode.YOLO,
      planExecutionMode: ApprovalMode.AUTO_EDIT,
    });

    session.dispose();
    expect(unsubscribeApprovalModeChange).toHaveBeenCalledOnce();
  });

  it('reloads model providers from the session-owned settings', async () => {
    const modelProviders = {
      idealab: [{ id: 'qwen3', baseUrl: 'https://idealab.example/v1' }],
    };
    Object.assign(mockSettings.merged, {
      modelProviders,
      providerProtocol: { idealab: 'openai' },
      imageModel: 'openai:image-01\0https://images.example/v1',
    });

    await session.reloadModelProvidersFromDisk();
    expect(mockConfig.setImageModel).toHaveBeenCalledWith(
      'openai:image-01\0https://images.example/v1',
    );

    expect(mockSettings.reloadScopesFromDiskAtomically).toHaveBeenCalledWith([
      SettingScope.User,
      SettingScope.Workspace,
    ]);
    expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalledWith(
      modelProviders,
      { idealab: 'openai' },
    );
  });

  it.each([false, true])(
    'preserves the selected subscription and catalog after logout (other provider: %s)',
    async (hasProvider) => {
      let auth: AuthType | undefined = AuthType.QWEN_SUBSCRIPTION;
      vi.mocked(mockConfig.getAuthType).mockImplementation(() => auth);
      const clearAuth = vi.fn(() => {
        auth = undefined;
      });
      Object.assign(mockConfig, {
        clearAuth,
        setSubscriptionPlan: vi.fn(),
        getCurrentModelRegistryBaseUrl: vi.fn(),
      });
      vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(
        hasProvider
          ? [
              {
                id: 'bailian',
                label: 'Bailian',
                authType: AuthType.USE_OPENAI,
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              },
            ]
          : [],
      );
      vi.mocked(mockConfig.switchModel).mockImplementation(async (next) => {
        auth = next;
      });
      vi.mocked(mockConfig.getModel).mockReturnValue('server-only-model');
      const registry = new core.BackgroundTaskRegistry();
      const controller = new AbortController();
      const task = registry.register({
        agentId: 'subscription-logout-agent',
        description: 'Subscription background agent',
        status: 'running',
        startTime: Date.now(),
        abortController: controller,
        isBackgrounded: true,
        outputFile: path.join(os.tmpdir(), `${randomUUID()}.jsonl`),
      });
      vi.mocked(mockConfig.getBackgroundTaskRegistry).mockReturnValue(registry);
      vi.spyOn(session, 'sendAvailableCommandsUpdate').mockResolvedValue(
        undefined,
      );
      await session.reloadModelProvidersFromDisk({
        subscriptionSignedOut: true,
      });
      expect(controller.signal.aborted).toBe(true);
      expect(task.status).toBe('cancelled');
      expect(task.persistedCancellationStatus).toBe('cancelled');
      expect(task.notified).toBe(true);
      expect(clearAuth).not.toHaveBeenCalled();
      expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
      expect(
        mockSettings.reloadScopesFromDiskAtomically,
      ).not.toHaveBeenCalled();
      expect(mockConfig.switchModel).not.toHaveBeenCalled();
      expect(auth).toBe(AuthType.QWEN_SUBSCRIPTION);
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/model-update',
        {
          v: 1,
          sessionId: 'test-session-id',
          currentModelId: expect.stringContaining('server-only-model'),
          subscriptionSignedOut: true,
        },
      );
    },
  );

  it('does not apply stale model providers when a settings scope cannot reload', async () => {
    vi.mocked(mockSettings.reloadScopesFromDiskAtomically).mockReturnValueOnce(
      false,
    );

    await expect(session.reloadModelProvidersFromDisk()).rejects.toThrow(
      'Unable to reload model-provider settings from disk.',
    );
    expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
  });

  it('bounds textual tool results at the live ACP delivery boundary', async () => {
    const source = `head-${'x'.repeat(499_999)}-tail`;
    await session.sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'large-call',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: source },
        },
      ],
      rawOutput: source,
      _meta: { toolName: 'read_file' },
    });

    const params = vi
      .mocked(mockClient.sessionUpdate)
      .mock.calls.at(-1)?.[0] as SessionNotification | undefined;
    expect(params).toBeDefined();
    const delivered = params?.update as unknown as Record<string, unknown>;
    expect(
      Buffer.byteLength(JSON.stringify(delivered['content']), 'utf8'),
    ).toBeLessThanOrEqual(65_536);
    expect(
      Buffer.byteLength(JSON.stringify(delivered['rawOutput']), 'utf8'),
    ).toBeLessThanOrEqual(65_536);
    expect(delivered).toHaveProperty('content');
    expect(delivered).toHaveProperty('rawOutput');

    await session.sendUpdate(params!.update);
    const redelivered = vi
      .mocked(mockClient.sessionUpdate)
      .mock.calls.at(-1)?.[0]?.update;
    expect(redelivered).toBe(params?.update);

    const replay = await collectHistoryReplayUpdates({
      sessionId: 'test-session-id',
      records: [
        chatRecord({
          uuid: 'large-tool-result',
          parentUuid: 'large-assistant',
          type: 'tool_result',
          message: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'large-replay-call',
                  name: 'read_file',
                  response: { output: source },
                },
              },
            ],
          },
          toolCallResult: {
            callId: 'large-replay-call',
            responseParts: [],
            resultDisplay: source,
          },
        }),
      ],
      cumulativeUsage: createReplayCumulativeUsage(),
    });
    const replayUpdate = replay.updates.find(
      (update) => update.sessionUpdate === 'tool_call_update',
    );
    expect(replayUpdate).toBeDefined();

    await session.sendUpdate(replayUpdate!);
    const replayDelivered = vi
      .mocked(mockClient.sessionUpdate)
      .mock.calls.at(-1)?.[0]?.update;
    expect(replayDelivered).toBe(replayUpdate);
  });

  describe('active work holds', () => {
    let changes: number;

    function createReportingSession(): void {
      session.dispose();
      changes = 0;
      session = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
        undefined,
        () => {
          changes++;
        },
      );
    }

    function holdIds(
      category: 'agent' | 'notification' | 'shell' | 'workflow',
    ): string[] {
      return session
        .collectActiveWorkHolds()
        .filter((hold) => hold.category === category)
        .map((hold) => hold.id);
    }

    it('derives agent holds from the registry, covering the cancel window', async () => {
      createReportingSession();
      expect(session.collectActiveWorkHolds()).toEqual([]);
      expect(session.isIdle()).toBe(true);

      // A cancelled-but-unfinalized agent still owes its terminal
      // notification. hasRunningTasks() would already call this idle, which is
      // exactly how a detached session got reaped inside the cancel window.
      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        ['agent-cancelled'],
      );
      expect(holdIds('agent')).toEqual(['agent-cancelled']);
      expect(session.isIdle()).toBe(false);
      expect(session.isTurnIdle()).toBe(true);

      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        [],
      );
      expect(session.collectActiveWorkHolds()).toEqual([]);
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('blocks standalone relocation for reported work and running monitors', () => {
      createReportingSession();
      expect(session.hasStandaloneRelocationBlockers()).toBe(false);

      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        ['agent-running'],
      );
      expect(session.hasStandaloneRelocationBlockers()).toBe(true);

      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        [],
      );
      mockMonitorRegistry.getAll.mockReturnValue([
        { id: 'monitor-running', status: 'running' },
      ]);
      expect(session.hasStandaloneRelocationBlockers()).toBe(true);

      mockMonitorRegistry.getAll.mockReturnValue([
        { id: 'monitor-complete', status: 'completed' },
      ]);
      expect(session.hasStandaloneRelocationBlockers()).toBe(false);
      session.dispose();
    });

    it('notifies the owner when the registry reports a status change', async () => {
      createReportingSession();
      const statusChanged =
        mockBackgroundTaskRegistry.setStatusChangeCallback.mock.calls.at(
          -1,
        )?.[0] as (() => void) | undefined;
      const before = changes;
      statusChanged?.();
      expect(changes).toBe(before + 1);

      session.dispose();
      // Retracts the exact callback it installed rather than blanking the slot.
      // The registry holds one callback and the TUI uses the same registry, so
      // an unconditional clear on dispose would unhook whoever owns it now.
      expect(
        mockBackgroundTaskRegistry.clearStatusChangeCallback,
      ).toHaveBeenCalledWith(statusChanged);
      expect(
        mockBackgroundTaskRegistry.setStatusChangeCallback,
      ).not.toHaveBeenCalledWith(undefined);
    });

    it('reports monitor start and completion through the existing active-work callback', () => {
      createReportingSession();
      const callback =
        mockMonitorRegistry.setStatusChangeCallback.mock.calls.at(
          -1,
        )?.[0] as () => void;
      const before = changes;
      mockMonitorRegistry.getAll.mockReturnValue([{ status: 'running' }]);
      callback();
      expect(changes).toBeGreaterThan(before);
      expect(session.hasRunningBackgroundTasks()).toBe(true);
      mockMonitorRegistry.getAll.mockReturnValue([{ status: 'cancelled' }]);
      callback();
      expect(session.hasRunningBackgroundTasks()).toBe(false);
      session.dispose();
      expect(
        mockMonitorRegistry.clearStatusChangeCallback,
      ).toHaveBeenCalledWith(callback);
      expect(
        mockMonitorRegistry.setStatusChangeCallback,
      ).not.toHaveBeenCalledWith(undefined);
    });

    it('reports running tasks independently of unfinalized agents and queued notifications', () => {
      createReportingSession();
      expect(session.hasRunningBackgroundTasks()).toBe(false);
      mockBackgroundTaskRegistry.hasRunningTasks.mockReturnValue(true);
      expect(session.hasRunningBackgroundTasks()).toBe(true);
      mockBackgroundTaskRegistry.hasRunningTasks.mockReturnValue(false);
      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        ['cancelled-agent'],
      );
      expect(session.hasRunningBackgroundTasks()).toBe(false);
      mockBackgroundShellRegistry.hasRunningEntries.mockReturnValue(true);
      expect(session.hasRunningBackgroundTasks()).toBe(true);
      mockBackgroundShellRegistry.hasRunningEntries.mockReturnValue(false);
      mockWorkflowRunRegistry.hasRunningEntries.mockReturnValue(true);
      expect(session.hasRunningBackgroundTasks()).toBe(true);
      mockWorkflowRunRegistry.hasRunningEntries.mockReturnValue(false);
      mockMonitorRegistry.getAll.mockReturnValue([{ status: 'running' }]);
      expect(session.hasRunningBackgroundTasks()).toBe(true);
      mockMonitorRegistry.getAll.mockReturnValue([{ status: 'completed' }]);
      expect(session.hasRunningBackgroundTasks()).toBe(false);
      session.dispose();
      expect(session.hasRunningBackgroundTasks()).toBe(false);
    });

    it('represents any number of running shells with one aggregate hold', () => {
      createReportingSession();
      mockBackgroundShellRegistry.hasRunningEntries.mockImplementation(() =>
        (
          mockBackgroundShellRegistry.getAll() as Array<{ status: string }>
        ).some((entry) => entry.status === 'running'),
      );
      mockBackgroundShellRegistry.getAll.mockReturnValue(
        Array.from({ length: 2_000 }, (_unused, index) => ({
          id: `shell-${index}`,
          status: 'running',
        })),
      );

      expect(holdIds('shell')).toEqual(['background-shells']);
      expect(session.collectActiveWorkHolds()).toHaveLength(1);
      expect(session.isIdle()).toBe(false);

      mockBackgroundShellRegistry.getAll.mockReturnValue([]);
      expect(session.collectActiveWorkHolds()).toEqual([]);
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('holds executing workflow runs but never paused ones', () => {
      mockWorkflowRunRegistry.list.mockReturnValue([
        { runId: 'wf-running', status: 'running' },
        { runId: 'wf-pausing', status: 'pausing' },
        { runId: 'wf-paused', status: 'paused' },
        { runId: 'wf-complete', status: 'completed' },
      ]);
      createReportingSession();

      // Mirrors the registry's hasRunningEntries(): a paused run executes
      // nothing and no backstop would ever release the hold, so it must
      // not pin the session forever.
      expect(holdIds('workflow')).toEqual(['wf-running', 'wf-pausing']);
      expect(session.isIdle()).toBe(false);

      mockWorkflowRunRegistry.list.mockReturnValue([
        { runId: 'wf-paused', status: 'paused' },
      ]);
      expect(session.collectActiveWorkHolds()).toEqual([]);
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('holds a workflow run that is reserved but not yet registered', () => {
      // Between `reserveStart` and `register` the run has no `list()`
      // entry, yet the registry's hasRunningEntries() and the liveness
      // gates already count it as live. A daemon conditional close that
      // read no hold here disposed the session and aborted the start
      // under the client that just asked for it.
      mockWorkflowRunRegistry.listStartingRunIds.mockReturnValue([
        'wf-starting',
      ]);
      mockWorkflowRunRegistry.list.mockReturnValue([
        { runId: 'wf-paused', status: 'paused' },
      ]);
      createReportingSession();

      expect(holdIds('workflow')).toEqual(['wf-starting']);
      expect(session.isIdle()).toBe(false);

      // Registration takes over with the entry's own running hold; a
      // failed or cancelled start drops the reservation.
      mockWorkflowRunRegistry.listStartingRunIds.mockReturnValue([]);
      expect(session.collectActiveWorkHolds()).toEqual([]);
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('tracks shell status changes and retracts only its callback', () => {
      createReportingSession();
      const statusChanged =
        mockBackgroundShellRegistry.setStatusChangeCallback.mock.calls.at(
          -1,
        )?.[0] as (() => void) | undefined;
      const before = changes;
      statusChanged?.();
      expect(changes).toBe(before + 1);

      session.dispose();
      expect(
        mockBackgroundShellRegistry.clearStatusChangeCallback,
      ).toHaveBeenCalledWith(statusChanged);
      expect(
        mockBackgroundShellRegistry.setStatusChangeCallback,
      ).not.toHaveBeenCalledWith(undefined);
    });

    it('holds a queued shell notification before its continuation can start', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      createReportingSession();
      const releaseCloseGate = session.beginClose();
      const notify =
        mockBackgroundShellRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { shellId: string; status: string },
        ) => void;

      notify('Shell completed.', '<task-notification />', {
        shellId: 'shell-queued',
        status: 'completed',
      });

      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(holdIds('shell')).toEqual(['background-shells']);
      expect(session.isIdle()).toBe(false);

      releaseCloseGate();
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      session.dispose();
    });

    it('holds an Agent terminal notification from persistence to continuation', async () => {
      let finishPersistence!: () => void;
      mockChatRecordingService.recordNotificationStrict.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPersistence = resolve;
          }),
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      createReportingSession();

      const notification = session.enqueueBackgroundNotification({
        displayText: 'Agent completed.',
        modelText: '<task-notification />',
        taskId: 'agent-persisting',
        status: 'completed',
        kind: 'agent',
      });
      await vi.waitFor(() =>
        expect(holdIds('notification')).toEqual(['agent-persisting']),
      );
      expect(session.isIdle()).toBe(false);

      finishPersistence();
      await expect(notification).resolves.toEqual({ accepted: true });
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('holds a queued workflow completion notification', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      createReportingSession();
      const releaseCloseGate = session.beginClose();
      const notify =
        mockWorkflowRunRegistry.setCompletionCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { runId: string; status: 'completed' },
        ) => void;

      notify('Workflow completed.', '<task-notification />', {
        runId: 'wf-queued',
        status: 'completed',
      });

      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(holdIds('notification')).toEqual(['wf-queued']);
      expect(session.isIdle()).toBe(false);

      releaseCloseGate();
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      session.dispose();
    });

    it('does not hold for a Monitor notification', async () => {
      let finishPersistence!: () => void;
      mockChatRecordingService.recordNotificationStrict.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPersistence = resolve;
          }),
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      createReportingSession();

      const notification = session.enqueueBackgroundNotification({
        displayText: 'Monitor fired.',
        modelText: '<task-notification />',
        taskId: 'monitor-persisting',
        status: 'completed',
        kind: 'monitor',
      });
      await vi.waitFor(() =>
        expect(
          mockChatRecordingService.recordNotificationStrict,
        ).toHaveBeenCalledOnce(),
      );
      // Monitors are outside activeWork's declared scope.
      expect(session.collectActiveWorkHolds()).toEqual([]);

      finishPersistence();
      await expect(notification).resolves.toEqual({ accepted: true });
      session.dispose();
    });

    it('keeps holding while the parent continuation runs', async () => {
      let releaseNotification!: () => void;
      const notificationGate = new Promise<void>((resolve) => {
        releaseNotification = resolve;
      });
      async function* notificationStream() {
        yield {
          type: core.StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'working' }] } }],
          },
        };
        await notificationGate;
      }
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(notificationStream());
      createReportingSession();
      const notify =
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

      notify('Agent completed.', '<task-notification />', {
        agentId: 'agent-1',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(holdIds('notification')).toEqual(['agent-1']),
      );
      expect(session.isIdle()).toBe(false);

      // The agent itself is finished; the hold now belongs to the terminal
      // notification and its continuation turn, so the session stays held.
      mockBackgroundTaskRegistry.listUnfinalizedBackgroundAgentIds.mockReturnValue(
        [],
      );
      await Promise.resolve();
      expect(holdIds('notification')).toEqual(['agent-1']);

      releaseNotification();
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('keeps a shell hold across queue-to-continuation handoff', async () => {
      let releaseNotification!: () => void;
      const notificationGate = new Promise<void>((resolve) => {
        releaseNotification = resolve;
      });
      async function* notificationStream() {
        yield {
          type: core.StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'working' }] } }],
          },
        };
        await notificationGate;
      }
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(notificationStream());
      createReportingSession();
      const notify =
        mockBackgroundShellRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { shellId: string; status: string },
        ) => void;

      notify('Shell completed.', '<task-notification />', {
        shellId: 'shell-1',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(holdIds('shell')).toEqual(['background-shells']),
      );
      expect(session.isIdle()).toBe(false);

      releaseNotification();
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('releases the shell hold after a continuation failure', async () => {
      let rejectNotification!: (reason: Error) => void;
      mockChat.sendMessageStream = vi.fn().mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectNotification = reject;
        }),
      );
      createReportingSession();
      const notify =
        mockBackgroundShellRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { shellId: string; status: string },
        ) => void;

      notify('Shell failed.', '<task-notification />', {
        shellId: 'shell-1',
        status: 'failed',
      });
      await vi.waitFor(() =>
        expect(holdIds('shell')).toEqual(['background-shells']),
      );

      rejectNotification(new Error('continuation failed'));
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      session.dispose();
    });

    it('drains a shell notification stranded when the owning prompt errors out', async () => {
      let rejectPrompt!: (reason: Error) => void;
      mockChat.sendMessageStream = vi.fn().mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      );
      createReportingSession();
      const notify =
        mockBackgroundShellRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { shellId: string; status: string },
        ) => void;

      // Start a prompt and let it reach the model send before the shell
      // completes, so the completion notification queues while the prompt is
      // still pending.
      const promptPromise = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });
      await vi.waitFor(() =>
        expect(mockChat.sendMessageStream).toHaveBeenCalledOnce(),
      );

      notify('Shell completed.', '<task-notification />', {
        shellId: 'shell-stranded',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(holdIds('shell')).toEqual(['background-shells']),
      );

      // The prompt then fails with a plain provider error (not loop detection
      // or a stop guard), which previously stranded the queued notification.
      rejectPrompt(new Error('provider failed'));
      await expect(promptPromise).rejects.toThrow('provider failed');

      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      expect(session.isIdle()).toBe(true);
      session.dispose();
    });

    it('releases the shell hold after a cancelled continuation exits', async () => {
      let releaseNotification!: () => void;
      const notificationGate = new Promise<void>((resolve) => {
        releaseNotification = resolve;
      });
      async function* notificationStream() {
        yield {
          type: core.StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'working' }] } }],
          },
        };
        await notificationGate;
      }
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(notificationStream());
      createReportingSession();
      const notify =
        mockBackgroundShellRegistry.setNotificationCallback.mock.calls.at(
          -1,
        )?.[0] as (
          displayText: string,
          modelText: string,
          meta: { shellId: string; status: string },
        ) => void;

      notify('Shell completed.', '<task-notification />', {
        shellId: 'shell-1',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(holdIds('shell')).toEqual(['background-shells']),
      );
      await vi.waitFor(() =>
        expect(mockChat.sendMessageStream).toHaveBeenCalledOnce(),
      );

      await session.cancelPendingPrompt();
      expect(holdIds('shell')).toEqual(['background-shells']);
      releaseNotification();
      await vi.waitFor(() =>
        expect(session.collectActiveWorkHolds()).toEqual([]),
      );
      session.dispose();
    });
  });

  const makeWorkflowApproval = (approvalId: string): core.WorkflowApproval => ({
    approvalId,
    subagentId: `agent-${approvalId}`,
    callId: `call-${approvalId}`,
    name: 'run_shell_command',
    description: 'Run command',
    confirmationDetails: {
      type: 'exec',
      title: 'Run command',
      command: 'echo safe',
      rootCommand: 'echo',
      hideAlwaysAllow: true,
    },
    at: 1,
  });

  it('bridges workflow approvals through ACP permission requests', async () => {
    mockToolRegistry.getTool.mockReturnValue({
      displayName: 'Shell',
      kind: core.Kind.Execute,
      build: vi.fn().mockReturnValue({
        getDescription: vi.fn().mockReturnValue('echo safe'),
        toolLocations: vi
          .fn()
          .mockReturnValue([{ path: '/repo/script.sh', line: 3 }]),
      }),
    });
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback | undefined;
    expect(callback).toBeTypeOf('function');

    await callback?.(
      { runId: 'wf_1' } as core.WorkflowTask,
      {
        approvalId: 'wfap_1',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'run_shell_command',
        description: 'Run a safe command',
        confirmationDetails: {
          type: 'exec',
          title: 'Run command',
          command: 'echo safe',
          rootCommand: 'echo',
          hideAlwaysAllow: true,
        },
        at: 1,
      },
      { command: 'echo safe' },
      new AbortController().signal,
    );

    expect(mockClient.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session-id',
        options: [
          expect.objectContaining({
            optionId: core.ToolConfirmationOutcome.ProceedOnce,
          }),
          expect.objectContaining({
            optionId: core.ToolConfirmationOutcome.Cancel,
          }),
        ],
        toolCall: expect.objectContaining({
          toolCallId: 'workflow:test-session-id:wf_1:wfap_1',
          title: 'Shell: echo safe',
          kind: 'execute',
          locations: [{ path: '/repo/script.sh', line: 3 }],
          rawInput: { command: 'echo safe' },
          _meta: expect.objectContaining({
            toolName: 'run_shell_command',
            workflowApproval: true,
          }),
        }),
      }),
    );
    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_1',
      'wfap_1',
      core.ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-id',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'workflow:test-session-id:wf_1:wfap_1',
        status: 'completed',
      }),
    });
  });

  it('serializes concurrent workflow approvals for single-flight ACP clients', async () => {
    let resolveFirst:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    let resolveSecond:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    vi.mocked(mockClient.requestPermission)
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const first = callback(
      { runId: 'wf_concurrent' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_first'),
      { command: 'echo first' },
      new AbortController().signal,
    );
    const second = callback(
      { runId: 'wf_concurrent' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_second'),
      { command: 'echo second' },
      new AbortController().signal,
    );

    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    });
    resolveFirst?.({
      outcome: {
        outcome: 'selected',
        optionId: core.ToolConfirmationOutcome.ProceedOnce,
      },
    });
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledTimes(2);
    });
    resolveSecond?.({
      outcome: {
        outcome: 'selected',
        optionId: core.ToolConfirmationOutcome.ProceedOnce,
      },
    });
    await Promise.all([first, second]);

    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_concurrent',
      'wfap_first',
      core.ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_concurrent',
      'wfap_second',
      core.ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
  });

  it('does not serialize permissions across sessions sharing one ACP connection', async () => {
    let settleFirst:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    let settleSecond:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    vi.mocked(mockClient.requestPermission)
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            settleSecond = resolve;
          }),
      );
    const secondWorkflowRunRegistry = {
      ...mockWorkflowRunRegistry,
      setApprovalRequestCallback: vi.fn(),
      resolvePendingApproval: vi.fn().mockResolvedValue(true),
    };
    const secondConfig = {
      ...mockConfig,
      getWorkflowRunRegistry: vi
        .fn()
        .mockReturnValue(secondWorkflowRunRegistry),
    } as unknown as Config;
    const secondSession = new Session(
      'second-session-id',
      secondConfig,
      mockClient,
      mockSettings,
    );
    const firstCallback = mockWorkflowRunRegistry.setApprovalRequestCallback
      .mock.calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const secondCallback = secondWorkflowRunRegistry.setApprovalRequestCallback
      .mock.calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const first = firstCallback(
      { runId: 'wf_first' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_first'),
      { command: 'echo first' },
      new AbortController().signal,
    );
    const second = secondCallback(
      { runId: 'wf_second' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_second'),
      { command: 'echo second' },
      new AbortController().signal,
    );

    // Neither request is answered and neither signal aborts, which is the
    // shape of an idle session nobody is watching: a sibling session sharing
    // the connection must still reach the client.
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledTimes(2);
    });
    expect(
      vi
        .mocked(mockClient.requestPermission)
        .mock.calls.map(([request]) => request.toolCall.toolCallId),
    ).toEqual([
      'workflow:test-session-id:wf_first:wfap_first',
      'workflow:second-session-id:wf_second:wfap_second',
    ]);

    settleFirst?.({ outcome: { outcome: 'cancelled' } });
    settleSecond?.({ outcome: { outcome: 'cancelled' } });
    await Promise.allSettled([first, second]);

    // The send half above only shows where the request went. Each session must
    // also settle its own approval against its own registry.
    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_first',
      'wfap_first',
      core.ToolConfirmationOutcome.Cancel,
      undefined,
    );
    expect(
      secondWorkflowRunRegistry.resolvePendingApproval,
    ).toHaveBeenCalledWith(
      'wf_second',
      'wfap_second',
      core.ToolConfirmationOutcome.Cancel,
      undefined,
    );
    expect(
      mockWorkflowRunRegistry.resolvePendingApproval.mock.calls.map(
        ([runId]) => runId,
      ),
    ).toEqual(['wf_first']);
    expect(
      secondWorkflowRunRegistry.resolvePendingApproval.mock.calls.map(
        ([runId]) => runId,
      ),
    ).toEqual(['wf_second']);

    secondSession.dispose();
  });

  it('advances the permission queue when a request is aborted without waiting for the orphaned RPC', async () => {
    let settleFirstTransport:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    vi.mocked(mockClient.requestPermission)
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            settleFirstTransport = resolve;
          }),
      )
      .mockResolvedValueOnce({
        outcome: {
          outcome: 'selected',
          optionId: core.ToolConfirmationOutcome.ProceedOnce,
        },
      });
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const firstAbort = new AbortController();
    const first = callback(
      { runId: 'wf_abort_queue' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_aborted'),
      { command: 'echo first' },
      firstAbort.signal,
    );
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    });
    const second = callback(
      { runId: 'wf_abort_queue' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_after_abort'),
      { command: 'echo second' },
      new AbortController().signal,
    );

    firstAbort.abort();
    await first;
    // The queue advances on abort — the second request is sent without
    // waiting for the orphaned first RPC to settle.
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledTimes(2);
    });
    await second;
    // Settle the orphaned RPC so no dangling promises remain.
    settleFirstTransport?.({ outcome: { outcome: 'cancelled' } });
  });

  it('drops a queued permission request that was abandoned before the head settled', async () => {
    let settleFirst:
      | ((response: RequestPermissionResponse) => void)
      | undefined;
    vi.mocked(mockClient.requestPermission)
      .mockImplementationOnce(
        () =>
          new Promise<RequestPermissionResponse>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        outcome: {
          outcome: 'selected',
          optionId: core.ToolConfirmationOutcome.ProceedOnce,
        },
      });
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const first = callback(
      { runId: 'wf_queued_abort' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_head'),
      { command: 'echo first' },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    });
    const queuedAbort = new AbortController();
    const queued = callback(
      { runId: 'wf_queued_abort' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_queued'),
      { command: 'echo second' },
      queuedAbort.signal,
    );
    expect(mockClient.requestPermission).toHaveBeenCalledOnce();

    queuedAbort.abort();
    await queued;
    settleFirst?.({ outcome: { outcome: 'cancelled' } });
    await first;
    // The head releasing must not resurrect the abandoned request. Published
    // after its caller is gone, it would sit on the host as a prompt nobody
    // can answer and no longer cancels.
    expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(mockWorkflowRunRegistry.resolvePendingApproval)
        .mock.calls.map(([, approvalId]) => approvalId),
    ).toEqual(['wfap_queued', 'wfap_head']);

    // Dropping it must not wedge the session queue either.
    await callback(
      { runId: 'wf_queued_abort' } as core.WorkflowTask,
      makeWorkflowApproval('wfap_after'),
      { command: 'echo third' },
      new AbortController().signal,
    );
    expect(mockClient.requestPermission).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(mockClient.requestPermission).mock.calls[1]?.[0].toolCall
        .toolCallId,
    ).toBe('workflow:test-session-id:wf_queued_abort:wfap_after');
  });

  it('fails a workflow approval closed when the ACP request times out', async () => {
    vi.mocked(mockClient.requestPermission).mockRejectedValue(
      new Error('Permission request timed out'),
    );
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;

    await callback(
      { runId: 'wf_timeout' } as core.WorkflowTask,
      {
        approvalId: 'wfap_timeout',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'run_shell_command',
        description: 'Run command',
        confirmationDetails: {
          type: 'exec',
          title: 'Run command',
          command: 'echo safe',
          rootCommand: 'echo',
          hideAlwaysAllow: true,
        },
        at: 1,
      },
      { command: 'echo safe' },
      new AbortController().signal,
    );

    expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_timeout',
      'wfap_timeout',
      core.ToolConfirmationOutcome.Cancel,
    );
    expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-id',
      update: expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'workflow:test-session-id:wf_timeout:wfap_timeout',
        status: 'failed',
      }),
    });
  });

  it('shows the restricted edit diff as reviewable ACP text', async () => {
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;

    await callback(
      { runId: 'wf_edit' } as core.WorkflowTask,
      {
        approvalId: 'wfap_edit',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'replace',
        description: 'Edit file',
        confirmationDetails: {
          type: 'edit',
          title: 'Edit file',
          fileName: 'example.ts',
          filePath: '/repo/example.ts',
          fileDiff: '-unsafe\n+safe',
          originalContent: null,
          newContent: '',
          hideAlwaysAllow: true,
          hideModify: true,
          skipIdeDiff: true,
        },
        at: 1,
      },
      { path: '/repo/example.ts' },
      new AbortController().signal,
    );

    const request = vi.mocked(mockClient.requestPermission).mock.calls[0]?.[0];
    expect(request?.toolCall.content).toContainEqual({
      type: 'content',
      content: { type: 'text', text: '-unsafe\n+safe' },
    });
    expect(request?.toolCall.content).not.toContainEqual(
      expect.objectContaining({ type: 'diff' }),
    );
  });

  it('rejects a persistent ACP workflow approval outcome that was not offered', async () => {
    vi.mocked(mockClient.requestPermission).mockResolvedValue({
      outcome: {
        outcome: 'selected',
        optionId: core.ToolConfirmationOutcome.ProceedAlwaysProject,
      },
    });
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;

    await callback(
      { runId: 'wf_persistent' } as core.WorkflowTask,
      {
        approvalId: 'wfap_persistent',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'run_shell_command',
        description: 'Run command',
        confirmationDetails: {
          type: 'exec',
          title: 'Run command',
          command: 'echo safe',
          rootCommand: 'echo',
          hideAlwaysAllow: false,
        },
        at: 1,
      },
      { command: 'echo safe' },
      new AbortController().signal,
    );

    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_persistent',
      'wfap_persistent',
      core.ToolConfirmationOutcome.Cancel,
    );
  });

  it('aborts an in-flight workflow approval and unregisters on dispose', async () => {
    vi.mocked(mockClient.requestPermission).mockImplementation(
      () => new Promise(() => {}),
    );
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const approval = callback(
      { runId: 'wf_dispose' } as core.WorkflowTask,
      {
        approvalId: 'wfap_dispose',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'write_file',
        description: 'Write file',
        confirmationDetails: {
          type: 'info',
          title: 'Write file',
          prompt: 'Allow?',
          hideAlwaysAllow: true,
        },
        at: 1,
      },
      { path: '/tmp/test' },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    });

    session.dispose();
    await approval;

    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_dispose',
      'wfap_dispose',
      core.ToolConfirmationOutcome.Cancel,
    );
    expect(
      mockWorkflowRunRegistry.setApprovalRequestCallback,
    ).toHaveBeenLastCalledWith(undefined);
  });

  it('aborts an in-flight ACP request when core clears the approval', async () => {
    vi.mocked(mockClient.requestPermission).mockImplementation(
      () => new Promise(() => {}),
    );
    const callback = mockWorkflowRunRegistry.setApprovalRequestCallback.mock
      .calls[0]?.[0] as core.WorkflowApprovalRequestCallback;
    const approvalAbort = new AbortController();
    const approval = callback(
      { runId: 'wf_cleared' } as core.WorkflowTask,
      {
        approvalId: 'wfap_cleared',
        subagentId: 'agent-1',
        callId: 'call-1',
        name: 'read_file',
        description: 'Read file',
        confirmationDetails: {
          type: 'info',
          title: 'Read file',
          prompt: 'Allow?',
          hideAlwaysAllow: true,
        },
        at: 1,
      },
      { path: '/tmp/test' },
      approvalAbort.signal,
    );
    await vi.waitFor(() => {
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
    });

    approvalAbort.abort();
    await approval;

    expect(mockWorkflowRunRegistry.resolvePendingApproval).toHaveBeenCalledWith(
      'wf_cleared',
      'wfap_cleared',
      core.ToolConfirmationOutcome.Cancel,
    );
  });

  describe('request lifecycle subscriptions', () => {
    const started: RequestLifecycleEvent = {
      v: 1,
      kind: 'request',
      executionId: 'request-1',
      sessionId: 'test-session-id',
      promptId: 'prompt-1',
      model: 'model-1',
      startedAt: 100,
      phase: 'started',
    };

    function lifecycleConfig(base: Config) {
      const listeners = new Set<(event: RequestLifecycleEvent) => void>();
      const unsubscribe = vi.fn();
      const config = {
        ...base,
        onRequestLifecycle: vi.fn(
          (listener: (event: RequestLifecycleEvent) => void) => {
            listeners.add(listener);
            return () => {
              unsubscribe();
              listeners.delete(listener);
            };
          },
        ),
      } as unknown as Config;
      return {
        config,
        listeners,
        unsubscribe,
        emit(event: RequestLifecycleEvent) {
          for (const listener of listeners) listener(event);
        },
      };
    }

    it('routes only matching sessions on the subscribed config instance', async () => {
      session.dispose();
      const first = lifecycleConfig(mockConfig);
      const other = lifecycleConfig(mockConfig);
      session = new Session(
        'test-session-id',
        first.config,
        mockClient,
        mockSettings,
      );
      const secondClient = {
        ...mockClient,
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;
      const second = new Session(
        'other-session',
        first.config,
        secondClient,
        mockSettings,
      );
      const thirdClient = {
        ...mockClient,
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;
      const third = new Session(
        'test-session-id',
        other.config,
        thirdClient,
        mockSettings,
      );
      try {
        vi.mocked(mockClient.sessionUpdate).mockClear();
        first.emit(started);
        await Promise.resolve();
        expect(mockClient.sessionUpdate).toHaveBeenCalledOnce();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: { executionLifecycle: started },
          },
        });
        expect(secondClient.sessionUpdate).not.toHaveBeenCalled();
        expect(thirdClient.sessionUpdate).not.toHaveBeenCalled();
        first.emit({ ...started, sessionId: 'other-session' });
        other.emit(started);
        await Promise.resolve();
        expect(mockClient.sessionUpdate).toHaveBeenCalledOnce();
        expect(secondClient.sessionUpdate).toHaveBeenCalledOnce();
        expect(thirdClient.sessionUpdate).toHaveBeenCalledOnce();
      } finally {
        second.dispose();
        third.dispose();
      }
    });

    it('retains the ACP identity while admitting rotated transcript owners and their late ends', async () => {
      session.dispose();
      const owner = lifecycleConfig(mockConfig);
      session = new Session(
        'test-session-id',
        owner.config,
        mockClient,
        mockSettings,
      );
      const otherClient = {
        ...mockClient,
        sessionUpdate: vi.fn().mockResolvedValue(undefined),
      } as unknown as AgentSideConnection;
      const otherSession = new Session(
        'other-session',
        owner.config,
        otherClient,
        mockSettings,
      );
      try {
        vi.mocked(mockClient.sessionUpdate).mockClear();
        owner.emit(started);
        owner.config.getSessionId = vi.fn().mockReturnValue('rotated-session');
        session.rebindGoalRuntimeForNewSession();
        const rotated = { ...started, sessionId: 'rotated-session' };
        owner.emit(rotated);
        owner.config.getSessionId = vi.fn().mockReturnValue('next-session');
        session.rebindGoalRuntimeForNewSession();
        owner.emit({ ...started, executionId: 'unaccepted-old-start' });
        owner.emit({
          ...started,
          phase: 'ended',
          endedAt: 120,
          durationMs: 20,
          outcome: 'success',
          subagentId: 'unaccepted-agent',
        });
        owner.emit({
          ...started,
          phase: 'ended',
          endedAt: 120,
          durationMs: 20,
          outcome: 'success',
        });
        owner.emit({
          ...rotated,
          phase: 'ended',
          endedAt: 120,
          durationMs: 20,
          outcome: 'success',
        });
        owner.emit({ ...started, sessionId: 'next-session' });
        await Promise.resolve();
        const calls = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params);
        expect(calls).toHaveLength(5);
        expect(calls.map((params) => params.sessionId)).toEqual(
          Array(5).fill('test-session-id'),
        );
        expect(
          calls.map((params) => params.update._meta?.['executionLifecycle']),
        ).toEqual([
          started,
          rotated,
          {
            ...started,
            phase: 'ended',
            endedAt: 120,
            durationMs: 20,
            outcome: 'success',
          },
          {
            ...rotated,
            phase: 'ended',
            endedAt: 120,
            durationMs: 20,
            outcome: 'success',
          },
          { ...started, sessionId: 'next-session' },
        ]);
        expect(otherClient.sessionUpdate).not.toHaveBeenCalled();
        owner.emit({ ...started, sessionId: 'other-session' });
        await Promise.resolve();
        expect(otherClient.sessionUpdate).toHaveBeenCalledOnce();
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(5);
      } finally {
        otherSession.dispose();
      }
    });

    it('retains every admitted late end beyond the SDK window and rejects repeated old ends', async () => {
      session.dispose();
      const owner = lifecycleConfig(mockConfig);
      session = new Session(
        'test-session-id',
        owner.config,
        mockClient,
        mockSettings,
      );
      vi.mocked(mockClient.sessionUpdate).mockClear();
      for (let i = 0; i < 257; i++)
        owner.emit({ ...started, executionId: `request-${i}` });
      owner.config.getSessionId = vi.fn().mockReturnValue('rotated-session');
      session.rebindGoalRuntimeForNewSession();
      const ended = {
        ...started,
        phase: 'ended' as const,
        endedAt: 120,
        durationMs: 20,
        outcome: 'success' as const,
      };
      for (let i = 0; i < 257; i++)
        owner.emit({ ...ended, executionId: `request-${i}` });
      owner.emit({ ...ended, executionId: 'request-256' });
      await Promise.resolve();
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(514);
      expect(
        vi.mocked(mockClient.sessionUpdate).mock.calls.at(-1)?.[0].update
          ._meta?.['executionLifecycle'],
      ).toEqual({ ...ended, executionId: 'request-256' });
    });

    it('delivers lifecycle output during reversible closing and suppresses disposed emissions', async () => {
      session.dispose();
      const owner = lifecycleConfig(mockConfig);
      session = new Session(
        'test-session-id',
        owner.config,
        mockClient,
        mockSettings,
      );
      const lateListener = [...owner.listeners][0];
      vi.mocked(mockClient.sessionUpdate).mockClear();
      owner.emit(started);
      const release = session.beginClose();
      owner.emit({
        ...started,
        phase: 'ended',
        endedAt: 120,
        durationMs: 20,
        outcome: 'success',
      });
      await Promise.resolve();
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(2);
      release();
      owner.emit({ ...started, executionId: 'request-2' });
      await Promise.resolve();
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(3);
      session.dispose();
      expect(owner.unsubscribe).toHaveBeenCalledOnce();
      expect(owner.listeners.size).toBe(0);
      owner.emit(started);
      lateListener?.(started);
      await Promise.resolve();
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(3);
      session.dispose();
      expect(owner.unsubscribe).toHaveBeenCalledOnce();
    });
  });

  it('forwards recording degradation and unsubscribes on dispose', async () => {
    let recordingFailureListener:
      | ((event: { sessionId: string; error: Error }) => Promise<void> | void)
      | undefined;
    const unsubscribe = vi.fn();
    session.dispose();
    mockConfig.onChatRecordingFailure = vi.fn((listener) => {
      recordingFailureListener = listener;
      return unsubscribe;
    });
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
    );

    await recordingFailureListener?.({
      sessionId: 'failed-session-id',
      error: new Error('private details'),
    });

    expect(mockClient.extNotification).toHaveBeenCalledWith(
      'qwen/notify/session/recording-degraded',
      {
        v: 1,
        sessionId: 'failed-session-id',
        reason: 'write_failed',
      },
    );
    session.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('registers the dedicated Live screen tool and routes it over extMethod', async () => {
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
      windowTitle: 'LIVE_APP_A',
      accessibilityText: 'AXWindow LIVE_APP_A',
      screenshotPath,
    });

    try {
      await session.enableLiveScreenContext();
      const screenTool = registered.get(CAPTURE_SCREEN_CONTEXT_TOOL_NAME);
      expect(screenTool?.name).toBe('capture_screen_context');
      const invocation = screenTool?.build({});
      expect(invocation).toBeDefined();
      await expect(invocation?.getDefaultPermission()).resolves.toBe('allow');
      await expect(
        invocation?.execute(new AbortController().signal),
      ).resolves.toMatchObject({
        returnDisplay: 'Captured Safari — LIVE_APP_A',
      });
      expect(mockClient.extMethod).toHaveBeenCalledWith(
        'qwen/control/live/capture-screen-context',
        { callerSessionId: 'test-session-id' },
      );
      const speakTool = registered.get(SPEAK_TO_USER_TOOL_NAME);
      const speakInvocation = speakTool?.build({ message: '测试语音' });
      await expect(speakInvocation?.getDefaultPermission()).resolves.toBe(
        'allow',
      );
      await speakInvocation?.execute(new AbortController().signal);
      expect(mockClient.extMethod).toHaveBeenCalledWith(
        'qwen/control/live/speak-to-user',
        { callerSessionId: 'test-session-id', message: '测试语音' },
      );
      expect(mockLlmClient.setTools).toHaveBeenCalledOnce();
    } finally {
      await fs.unlink(screenshotPath).catch(() => undefined);
    }
  });

  it('persists Realtime-owned dialogue without adding a backend model turn', async () => {
    await session.setLiveConversationActive(true);
    vi.spyOn(session, 'isIdle').mockReturnValue(false);
    const entries = [
      { role: 'user' as const, text: '你好' },
      { role: 'assistant' as const, text: '你好！' },
    ];

    await session.appendLiveConversationTranscript(
      entries,
      'qwen3.5-omni-plus-realtime',
    );

    expect(
      mockChatRecordingService.recordRealtimeConversation,
    ).toHaveBeenCalledWith(entries, 'qwen3.5-omni-plus-realtime');
    expect(mockChat.addHistory).not.toHaveBeenCalled();
    expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-id',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '你好' },
        _meta: {
          source: 'realtime_voice',
          qwenDiscreteMessage: true,
        },
      },
    });
    expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'test-session-id',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '你好！' },
        _meta: {
          source: 'realtime_voice',
          qwenDiscreteMessage: true,
        },
      },
    });
  });

  it('rejects a conflicting tool at the reserved Live Appshot name', async () => {
    mockToolRegistry.getTool.mockReturnValue({
      name: CAPTURE_SCREEN_CONTEXT_TOOL_NAME,
    });

    await expect(session.enableLiveScreenContext()).rejects.toThrow(
      /reserved for the trusted Live Appshot channel/u,
    );
    expect(mockToolRegistry.registerTool).not.toHaveBeenCalled();
  });

  it('holds standalone turns until exact directory binding is committed and released', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
    vi.mocked(mockConfig.assertCanStartTurn).mockClear();
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
    const assertIdentity = vi.fn().mockResolvedValue(undefined);

    await expect(session.assertCanStartTurn()).rejects.toMatchObject({
      data: { errorKind: 'working_directory_missing' },
    });
    expect(mockConfig.assertCanStartTurn).not.toHaveBeenCalled();

    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );
    await session.commitManagedConversationBinding(expectation);
    await expect(session.assertCanStartTurn()).rejects.toMatchObject({
      data: { errorKind: 'working_directory_missing' },
    });
    expect(mockConfig.assertCanStartTurn).not.toHaveBeenCalled();

    await session.releaseManagedConversationBinding(expectation);
    await expect(session.assertCanStartTurn()).resolves.toBeUndefined();
    expect(mockConfig.assertCanStartTurn).toHaveBeenCalledOnce();
    expect(assertIdentity).toHaveBeenCalledTimes(5);
  });

  it('rechecks standalone directory identity after writer admission', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
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
    const identityChanged = new RequestError(
      -32004,
      'The standalone working directory identity is compromised.',
      { errorKind: 'working_directory_compromised' },
    );
    const assertIdentity = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(identityChanged);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );
    await session.commitManagedConversationBinding(expectation);
    await session.releaseManagedConversationBinding(expectation);

    await expect(session.assertCanStartTurn()).rejects.toBe(identityChanged);
    expect(mockConfig.assertCanStartTurn).toHaveBeenCalledOnce();
    expect(assertIdentity).toHaveBeenCalledTimes(5);
  });

  it('activates a provisional standalone workspace once before commit', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.isProvisionalWorkspace).mockReturnValue(true);
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
    const assertIdentity = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn().mockResolvedValue(undefined);
    const onRelease = vi.fn();
    session.installManagedConversationActivation(activate, onRelease);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );

    await Promise.all([
      session.commitManagedConversationBinding(expectation),
      session.commitManagedConversationBinding(expectation),
    ]);
    await session.releaseManagedConversationBinding(expectation);

    expect(activate).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(assertIdentity).toHaveBeenCalledTimes(5);
    await expect(session.assertCanStartTurn()).resolves.toBeUndefined();
    await session.releaseManagedConversationBinding(expectation);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('retries a provisional activation refused by a liftable quarantine', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.isProvisionalWorkspace).mockReturnValue(true);
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
    const assertIdentity = vi.fn().mockResolvedValue(undefined);
    // The quarantine refusal lifts once the unproven stop is proven: the
    // first commit meets it, the second must be free to retry.
    const quarantined = new RequestError(
      -32024,
      'The Managed engine is quarantined.',
      { errorKind: 'managed_engine_quarantined' },
    );
    const activate = vi
      .fn()
      .mockRejectedValueOnce(quarantined)
      .mockResolvedValue(undefined);
    session.installManagedConversationActivation(activate);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );

    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(quarantined);
    await expect(
      session.commitManagedConversationBinding(expectation),
    ).resolves.toBeUndefined();
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("rejects with the peer's own error when its data is null", async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.isProvisionalWorkspace).mockReturnValue(true);
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
        device: 2,
        inode: 4,
      },
    };
    const assertIdentity = vi.fn().mockResolvedValue(undefined);
    // A peer that serializes an absent `data` as null: typeof null passes a
    // bare typeof === 'object' probe, and a refusal guard that dereferences
    // it throws a TypeError inside the catch — wedging the activation on a
    // rejected promise that masks this error forever.
    const peerError = { code: -32000, message: 'peer', data: null };
    const activate = vi
      .fn()
      .mockRejectedValueOnce(peerError)
      .mockResolvedValue(undefined);
    session.installManagedConversationActivation(activate);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );

    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(peerError);
    // Not the liftable quarantine refusal: the activation poisons with the
    // peer's own error, terminally, instead of wedging on a TypeError.
    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(peerError);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('treats an object-data refusal carrying another errorKind as terminal', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.isProvisionalWorkspace).mockReturnValue(true);
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
        device: 2,
        inode: 4,
      },
    };
    const assertIdentity = vi.fn().mockResolvedValue(undefined);
    // An object `data` is no confession: only the quarantine's own kind is
    // liftable, everything else is the terminal shape it always was.
    const peerError = {
      code: -32024,
      message: 'peer',
      data: { errorKind: 'session_writer_unavailable' },
    };
    const activate = vi
      .fn()
      .mockRejectedValueOnce(peerError)
      .mockResolvedValue(undefined);
    session.installManagedConversationActivation(activate);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );

    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(peerError);
    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(peerError);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('keeps a terminal activation failure poisoned', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.isProvisionalWorkspace).mockReturnValue(true);
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
    const assertIdentity = vi.fn().mockResolvedValue(undefined);
    // Any refusal that is not the liftable quarantine stays terminal: the
    // activation never retries behind a commit's back.
    const terminal = new Error('The Managed host is shutting down.');
    const activate = vi.fn().mockRejectedValue(terminal);
    session.installManagedConversationActivation(activate);
    session.installPendingManagedConversationBinding(
      expectation,
      assertIdentity,
    );

    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(terminal);
    await expect(
      session.commitManagedConversationBinding(expectation),
    ).rejects.toBe(terminal);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('drains automatic work that was queued before standalone release', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
    vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
    mockChat.sendMessageStream = vi.fn().mockResolvedValue(createEmptyStream());
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

    await expect(
      session.enqueueBackgroundNotification({
        displayText: 'Agent completed.',
        modelText: '<task-notification />',
        taskId: 'queued-before-release',
        status: 'completed',
        kind: 'agent',
      }),
    ).resolves.toEqual({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();

    await session.releaseManagedConversationBinding(expectation);

    await vi.waitFor(() =>
      expect(mockChat.sendMessageStream).toHaveBeenCalledOnce(),
    );
  });

  it('preserves a queued Goal turn until standalone release', async () => {
    session.dispose();
    vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
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
    const permit: core.GoalTurnPermit = {
      goalId: 'goal-1',
      revision: 1,
      turnId: 'turn-before-release',
    };
    mockGoalRuntime.getSnapshot.mockReturnValue({
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: 'finish after release',
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
      turnKey === 'goal-runtime:turn-before-release' ? permit : undefined,
    );
    mockChat.sendMessageStream = vi.fn().mockResolvedValue(createEmptyStream());

    await boundGoalHost!.startGoalTurn({
      permit,
      continuationContext: 'finish after release',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
    expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalled();

    await session.releaseManagedConversationBinding(expectation);

    await vi.waitFor(() =>
      expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit),
    );
    expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
  });

  it('attributes a delayed title notification to the persisted record session', () => {
    const callback = mockChatRecordingService.setTitleRecordedCallback.mock
      .calls[0]?.[0] as
      | ((title: string, source: string, sessionId: string) => void)
      | undefined;

    callback?.('Durable title', 'auto', 'persisted-session-id');

    expect(mockClient.extNotification).toHaveBeenCalledWith(
      'qwen/notify/session/title-update',
      {
        v: 1,
        sessionId: 'persisted-session-id',
        title: 'Durable title',
        titleSource: 'auto',
      },
    );
    expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'persisted-session-id',
      update: {
        sessionUpdate: 'session_info_update',
        title: 'Durable title',
      },
    });
  });

  describe('shell execution config plumbing', () => {
    it('passes the config shell execution settings to invocation.execute', async () => {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'hi',
        returnDisplay: 'hi',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'run_shell_command',
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue({
          params: { command: 'echo hi' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('echo hi'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute,
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-shell-1',
                    name: 'run_shell_command',
                    args: { command: 'echo hi' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run it' }],
      });

      expect(execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        { terminalWidth: 80, terminalHeight: 24, showColor: false },
      );
    });
  });

  describe('partial edit guard', () => {
    function useTool(kind: core.Kind, name: string) {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'done',
        returnDisplay: 'done',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name,
        kind,
        build: vi.fn().mockReturnValue({
          params: {},
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
          execute,
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      return execute;
    }

    function call(id: string, name = 'write_file'): FunctionCall {
      return { id, name, args: { file_path: '/tmp/notes.txt', content: 'p' } };
    }

    function cutOff(...calls: FunctionCall[]) {
      return {
        type: core.StreamEventType.CHUNK,
        value: {
          functionCalls: calls,
          candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
        },
      };
    }

    /** Runs one prompt and returns the tool-result message sent back. */
    async function prompt(
      ...chunks: Array<{ type: unknown; value?: unknown }>
    ): Promise<string> {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createStreamWithChunks(chunks))
        .mockResolvedValueOnce(createEmptyStream());
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write it' }],
      });
      return JSON.stringify(
        vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
      );
    }

    it('refuses an edit from a response the output limit cut off', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');

      const sent = await prompt(cutOff(call('call-cut')));

      expect(execute).not.toHaveBeenCalled();
      expect(sent).toContain('truncated due to max_tokens limit');
    });

    it('refuses an edit whose arguments arrived incomplete', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      const incomplete = call('call-incomplete');
      markToolCallArgumentsIncomplete([{ functionCall: incomplete }]);

      const sent = await prompt({
        type: core.StreamEventType.CHUNK,
        value: { functionCalls: [incomplete] },
      });

      expect(execute).not.toHaveBeenCalled();
      expect(sent).toContain('arguments arrived incomplete');
    });

    it('still runs a read from a response the output limit cut off', async () => {
      const execute = useTool(core.Kind.Read, 'read_file');

      await prompt(cutOff(call('call-read', 'read_file')));

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('runs the edit a retry produces after a cut-off attempt', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');

      const sent = await prompt(
        cutOff(call('call-cut')),
        { type: core.StreamEventType.RETRY },
        {
          type: core.StreamEventType.CHUNK,
          value: { functionCalls: [call('call-full')] },
        },
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(sent).not.toContain('truncated due to max_tokens limit');
    });

    it('counts a cut-off response with several edits once', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      const calls = ['a', 'b', 'c'].map((content, i) => ({
        ...call(`call-cut-${i}`),
        args: { file_path: `/tmp/notes-${i}.txt`, content },
      }));

      const sent = await prompt(cutOff(...calls));

      expect(execute).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(sent).toContain('truncated due to max_tokens limit');
      expect(sent).not.toContain('RETRY LOOP DETECTED');
    });

    it('warns on the second cut-off response and stops on the third', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-1'))]),
        )
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-2'))]),
        )
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-3'))]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'write it' }],
        }),
      ).rejects.toMatchObject({
        data: {
          code: 'LOOP_DETECTED',
          loopType: core.LoopType.INVALID_TOOL_PARAMS_STAGNATION,
        },
      });

      expect(execute).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      const warned = JSON.stringify(
        vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
      );
      expect(warned).toContain('RETRY LOOP DETECTED');
      expect(warned).toContain('Another refused write stops this turn.');
      expect(warned).not.toContain('parameter schema');
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Stopping ACP turn after repeated refused partial edits from write_file',
        ),
      );
    });

    it('starts the count again after the model recovers', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      const full = (id: string) =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: { functionCalls: [call(id)] },
          },
        ]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-1'))]),
        )
        .mockResolvedValueOnce(full('call-full-1'))
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-2'))]),
        )
        .mockResolvedValueOnce(full('call-full-2'))
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-3'))]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write it' }],
      });

      expect(execute).toHaveBeenCalledTimes(2);
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(6);
      const last = JSON.stringify(
        vi.mocked(mockChat.sendMessageStream).mock.calls[5][1].message,
      );
      expect(last).toContain('truncated due to max_tokens limit');
      expect(last).not.toContain('RETRY LOOP DETECTED');
    });

    it('starts the count again when the cause changes', async () => {
      useTool(core.Kind.Edit, 'write_file');
      const incomplete = call('call-incomplete');
      markToolCallArgumentsIncomplete([{ functionCall: incomplete }]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: { functionCalls: [incomplete] },
            },
          ]),
        )
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut'))]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write it' }],
      });

      const second = JSON.stringify(
        vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
      );
      expect(second).toContain('truncated due to max_tokens limit');
      expect(second).not.toContain('RETRY LOOP DETECTED');
    });

    it('logs repeated refusals as observed when loop protection is off', async () => {
      useTool(core.Kind.Edit, 'write_file');
      mockConfig.getLoopProtection = vi.fn().mockReturnValue('off');
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-1'))]),
        )
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-2'))]),
        )
        .mockResolvedValueOnce(
          createStreamWithChunks([cutOff(call('call-cut-3'))]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write it' }],
      });

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      expect(
        logLoopProtectionSpy.mock.calls.map(([, event]) => [
          event.loop_type,
          event.decision,
        ]),
      ).toEqual([[core.LoopType.INVALID_TOOL_PARAMS_STAGNATION, 'observed']]);
    });
  });

  describe('shared agent loop round (experimental.unifiedAgentLoop)', () => {
    type RoundEvent = core.ServerLlmStreamEvent;

    /** Streams each round's events from LlmClient, then empty rounds. */
    function useSharedRounds(...rounds: RoundEvent[][]) {
      mockConfig.isUnifiedAgentLoopEnabled = vi.fn().mockReturnValue(true);
      Object.assign(mockLlmClient, {
        admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
      });
      const send = vi.fn();
      for (const events of rounds) {
        send.mockImplementationOnce(() =>
          (async function* () {
            for (const event of events) yield event;
          })(),
        );
      }
      send.mockImplementation(() => createEmptyStream());
      Object.assign(mockLlmClient, { sendMessageStream: send });
      return send;
    }

    const text = (value: string): RoundEvent => ({
      type: core.LlmEventType.Content,
      value,
    });
    const finished = (
      reason = FinishReason.STOP,
      usageMetadata?: object,
    ): RoundEvent => ({
      type: core.LlmEventType.Finished,
      value: { reason, usageMetadata },
    });
    const toolCall = (functionCall: FunctionCall): RoundEvent => ({
      type: core.LlmEventType.ToolCallRequest,
      value: {
        callId: functionCall.id!,
        name: functionCall.name!,
        args: functionCall.args ?? {},
        isClientInitiated: false,
        prompt_id: 'test-session-id########1',
      },
      functionCall,
    });

    /** Runs each call of a shared batch with the registry's tool. */
    async function runEachTool(
      _host: unknown,
      { requests }: { requests: core.ToolCallRequestInfo[] },
    ) {
      const results = [];
      for (const request of requests) {
        const output = await mockToolRegistry
          .getTool(request.name)
          .build(request.args)
          .execute(new AbortController().signal);
        const part = {
          functionResponse: {
            id: request.callId,
            name: request.name,
            response: { output: output.llmContent },
          },
        };
        results.push({
          request,
          executionRequest: request,
          response: {
            callId: request.callId,
            responseParts: [part],
            resultDisplay: output.returnDisplay,
            executionStatus: 'success',
          },
          status: 'success',
          origin: 'executed',
        });
      }
      return {
        parts: results.flatMap(({ response }) => response.responseParts),
        results,
        stopAfterPermissionCancel: false,
      };
    }

    function useTool(kind: core.Kind, name: string) {
      runAcpToolBatchSpy.mockImplementation(runEachTool);
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'done',
        returnDisplay: 'done',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name,
        kind,
        build: vi.fn().mockReturnValue({
          params: {},
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
          execute,
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      return execute;
    }

    const prompt = (extra: object = {}) =>
      session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
        ...extra,
      });

    const updates = () =>
      vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([notification]) => notification.update);
    const agentText = () =>
      updates()
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) =>
          update.content?.type === 'text' ? update.content.text : '',
        )
        .filter((value) => value.length > 0);

    it('sends a fresh prompt as a UserQuery whose user turn it recorded', async () => {
      const send = useSharedRounds([text('Hello'), finished()]);
      mockConfig.prepareWorkflowMode = vi.fn();

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][3]).toMatchObject({
        type: core.SendMessageType.UserQuery,
        userTurnRecordedByHost: true,
        workflowModeEligible: true,
        interactionSpanByHost: true,
        promptAdmission: { blocked: false },
        // Recall searches the prompt text, not the resolved request.
        memoryRecallQuery: 'hello',
      });
      expect(mockConfig.prepareWorkflowMode).not.toHaveBeenCalled();
      // The client runs its own tool-call guards for the shared tool batch.
      expect(send.mock.calls[0][3]).not.toHaveProperty('toolLoopGuardsByHost');
      expect(agentText()).toContain('Hello');
      // The session snapshots its user turn; the option keeps the client's off.
      expect(mockFileHistoryService.makeSnapshot).toHaveBeenCalledOnce();
      // The client ran the memory tasks when the response stopped; ACP
      // reports no memory updates, so the queued tasks are taken at once.
      expect(
        mockLlmClient.runManagedAutoMemoryBackgroundTasks,
      ).not.toHaveBeenCalled();
      expect(
        mockLlmClient.consumePendingMemoryTaskPromises,
      ).toHaveBeenCalledOnce();
      expect(mockMemoryManager.scheduleExtract).not.toHaveBeenCalled();
    });

    it('runs a channel prompt on the shared round, without a submitted prompt', async () => {
      const send = useSharedRounds([text('Hello'), finished()]);

      // A channel's own submission is not passed on as the user's.
      await prompt({
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          'qwen.daemon.submittedPrompt': 'hello',
        },
      });

      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][3]).toMatchObject({
        type: core.SendMessageType.UserQuery,
      });
      expect(send.mock.calls[0][3]).not.toHaveProperty('submittedPrompt');
      expect(send.mock.calls[0][3]).not.toHaveProperty('humanInput');
      expect(
        (
          mockLlmClient as unknown as {
            admitUserPrompt: ReturnType<typeof vi.fn>;
          }
        ).admitUserPrompt,
      ).toHaveBeenCalledWith(
        'hello',
        'test-session-id########1',
        expect.objectContaining({ submittedPrompt: undefined }),
      );
    });

    it.each([
      ['the Stop hook reached its cap', 'cap'],
      ['the guard gave way to a queued prompt', 'queued'],
      ['the guard gave way to a queued prompt in plan mode', 'plan-queued'],
      ['the guard was exhausted', 'exhausted'],
    ] as const)(
      'does not start the Goal a turn proposed once %s',
      async (_label, way) => {
        mockConfig.getGoalProposalHostSupported = vi.fn().mockReturnValue(true);
        mockConfig.takePendingGoalProposal = vi.fn().mockReturnValue({
          objective: 'make the tests pass',
          turnKey: 'test-session-id########1',
        });
        const internals = session as unknown as {
          todoStopGuardQueuedPromptPriority: boolean;
          todoStopGuard: { decide: () => unknown };
        };
        if (way === 'exhausted') {
          vi.spyOn(internals.todoStopGuard, 'decide').mockReturnValue({
            kind: 'exhausted',
            attempt: 2,
            maxAttempts: 2,
            unfinishedCount: 1,
          });
        }
        const send = useSharedRounds();
        send.mockImplementationOnce(
          (
            _parts: unknown,
            signal: AbortSignal,
            promptId: string,
            options: { stopPolicies: core.StopPolicy[] },
          ) =>
            (async function* () {
              yield text('Proposed a Goal.');
              yield finished();
              const [policy] = options.stopPolicies;
              if (way === 'cap') {
                policy!.onStopHookCap?.();
                return;
              }
              if (way === 'queued' || way === 'plan-queued') {
                internals.todoStopGuardQueuedPromptPriority = true;
              }
              if (way === 'plan-queued') {
                vi.mocked(mockConfig.getApprovalMode).mockReturnValue(
                  ApprovalMode.PLAN,
                );
              }
              expect(await policy!.continueAt({ promptId, signal })).toBe(
                undefined,
              );
            })(),
        );

        await prompt({ _meta: { 'qwen.goalProposalApproval': true } });

        expect(send).toHaveBeenCalledOnce();
        expect(agentText()).toContainEqual(
          expect.stringContaining('/goal set'),
        );
        expect(mockConfig.getGoalRuntimeReady).not.toHaveBeenCalled();
      },
    );

    it('starts the Goal a turn proposed when its stop point lets it stop', async () => {
      mockConfig.getGoalProposalHostSupported = vi.fn().mockReturnValue(true);
      mockConfig.takePendingGoalProposal = vi.fn().mockReturnValue({
        objective: 'make the tests pass',
        turnKey: 'test-session-id########1',
      });
      const send = useSharedRounds();
      send.mockImplementationOnce(
        (
          _parts: unknown,
          signal: AbortSignal,
          promptId: string,
          options: { stopPolicies: core.StopPolicy[] },
        ) =>
          (async function* () {
            yield text('Proposed a Goal.');
            yield finished();
            await options.stopPolicies[0]!.continueAt({ promptId, signal });
          })(),
      );

      await prompt({ _meta: { 'qwen.goalProposalApproval': true } });

      expect(mockConfig.getGoalRuntimeReady).toHaveBeenCalled();
    });

    it('takes the file-history snapshot of a prompt cancelled before its first send', async () => {
      const send = useSharedRounds([text('Hello'), finished()]);
      Object.assign(mockLlmClient, {
        admitUserPrompt: vi.fn(async () => {
          await session.cancelPendingPrompt();
          return { blocked: false };
        }),
      });

      const result = await prompt();

      expect(result.stopReason).toBe('cancelled');
      expect(send).not.toHaveBeenCalled();
      // The cancelled prompt stays a user turn, so rewind needs its snapshot.
      expect(mockFileHistoryService.makeSnapshot).toHaveBeenCalledOnce();
      expect(mockFileHistoryService.makeSnapshot).toHaveBeenCalledWith(
        'test-session-id########1',
      );
    });

    it('runs the requested tools on the shared tool batch and sends their results', async () => {
      const execute = useTool(core.Kind.Read, 'read_file');
      const send = useSharedRounds(
        [
          toolCall({
            id: 'call-read',
            name: 'read_file',
            args: { file_path: '/tmp/a.txt' },
          }),
          finished(),
        ],
        [text('Read it.'), finished()],
      );

      await prompt();

      expect(runAcpToolBatchSpy).toHaveBeenCalledOnce();
      expect(runAcpToolBatchSpy.mock.calls[0][1].requests).toEqual([
        expect.objectContaining({ callId: 'call-read', name: 'read_file' }),
      ]);
      expect(execute).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(2);
      const [parts, , , options] = send.mock.calls[1];
      expect(options).toMatchObject({ type: core.SendMessageType.ToolResult });
      expect(
        (parts as Part[]).map((part) => part.functionResponse?.id),
      ).toContain('call-read');
    });

    it('keeps its own tool step and tool-call guards in a session with live tools', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      (
        session as unknown as { liveScreenContextTool: object }
      ).liveScreenContextTool = {};
      const send = useSharedRounds([
        toolCall({
          id: 'call-cut',
          name: 'write_file',
          args: { file_path: '/tmp/notes.txt', content: 'p' },
        }),
        finished(FinishReason.MAX_TOKENS),
      ]);

      await prompt();

      expect(runAcpToolBatchSpy).not.toHaveBeenCalled();
      expect(send.mock.calls[0][3]).toMatchObject({
        toolLoopGuardsByHost: true,
      });
      // The session's own executor refuses the edit the limit cut off.
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(send.mock.calls[1][0])).toContain(
        'truncated due to max_tokens limit',
      );
    });

    it('reports a UserPromptSubmit block without sending the prompt', async () => {
      const send = useSharedRounds([
        {
          type: core.LlmEventType.UserPromptSubmitBlocked,
          value: { reason: 'not today', originalPrompt: 'hello' },
        },
      ]);
      Object.assign(mockLlmClient, {
        admitUserPrompt: vi.fn().mockResolvedValue({ blocked: true }),
      });

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][3]).toMatchObject({
        promptAdmission: { blocked: true },
      });
      expect(agentText()).toContain(
        '✗ **UserPromptSubmit blocked**: not today',
      );
      expect(mockConfig.getFileHistoryService).not.toHaveBeenCalled();
    });

    it('reports a UserPromptSubmit block of a tool-result round and ends the turn', async () => {
      useTool(core.Kind.Read, 'read_file');
      const send = useSharedRounds(
        [
          toolCall({
            id: 'call-read',
            name: 'read_file',
            args: { file_path: '/tmp/a.txt' },
          }),
          finished(),
        ],
        [
          {
            type: core.LlmEventType.UserPromptSubmitBlocked,
            value: { reason: 'secret in output', originalPrompt: '' },
          },
        ],
      );

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      expect(send).toHaveBeenCalledTimes(2);
      expect(agentText()).toContain(
        '✗ **UserPromptSubmit blocked**: secret in output',
      );
      // The calls close with the block, not with the withheld output.
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-read',
              name: 'read_file',
              response: {
                error: expect.stringContaining('UserPromptSubmit hook blocked'),
              },
            },
          },
        ],
      });
      expect(
        JSON.stringify(vi.mocked(mockChat.addHistory).mock.calls),
      ).not.toContain('done');
      expect(
        mockLlmClient.runManagedAutoMemoryBackgroundTasks,
      ).not.toHaveBeenCalled();
    });

    it('keeps the input taken with the results of a tool-result round the hook blocked', async () => {
      useTool(core.Kind.Read, 'read_file');
      let drained = false;
      vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
        if (method === 'craft/drainMidTurnQueue' && !drained) {
          drained = true;
          return { messages: ['use plan B instead'], hasQueuedPrompt: false };
        }
        return { messages: [] };
      });
      useSharedRounds(
        [
          toolCall({
            id: 'call-read',
            name: 'read_file',
            args: { file_path: '/tmp/a.txt' },
          }),
          finished(),
        ],
        [
          {
            type: core.LlmEventType.UserPromptSubmitBlocked,
            value: { reason: 'secret in output', originalPrompt: '' },
          },
        ],
      );

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      const closed = vi
        .mocked(mockChat.addHistory)
        .mock.calls.map(([content]) => content)
        .find((content) =>
          content.parts?.some(
            (part) => part.functionResponse?.id === 'call-read',
          ),
        );
      expect(closed?.parts?.[0]).toMatchObject({
        functionResponse: {
          id: 'call-read',
          response: {
            error: expect.stringContaining('UserPromptSubmit hook blocked'),
          },
        },
      });
      // The input the drain took is already shown as delivered.
      expect(JSON.stringify(closed?.parts?.slice(1))).toContain(
        'use plan B instead',
      );
    });

    it('keeps the results of a tool-result round that failed before its request went out', async () => {
      useTool(core.Kind.Read, 'read_file');
      let pushes = 0;
      Object.assign(mockChat, {
        getUserContentPushCount: vi.fn(() => pushes),
      });
      const send = useSharedRounds();
      send
        .mockImplementationOnce(() =>
          (async function* () {
            pushes++;
            yield toolCall({
              id: 'call-read',
              name: 'read_file',
              args: { file_path: '/tmp/a.txt' },
            });
            yield finished();
          })(),
        )
        // The client throws before the push when the tool-result round's
        // UserPromptSubmit hook request times out.
        .mockImplementationOnce(() =>
          (async function* () {
            if (pushes > 0) {
              throw new Error(
                'Request timed out waiting for hook-execution-response',
              );
            }
            yield text('never');
          })(),
        );

      await expect(prompt()).rejects.toThrow('Request timed out');

      expect(send).toHaveBeenCalledTimes(2);
      // The tools ran, so their results close the calls, not the repair's
      // "retry if needed".
      expect(mockChat.addHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-read',
                response: expect.objectContaining({ output: 'done' }),
              }),
            }),
          ]),
        }),
      );
    });

    it('judges a next-speaker continuation in the round by its own response', async () => {
      const execute = useTool(core.Kind.Edit, 'write_file');
      let pushes = 0;
      Object.assign(mockChat, {
        getUserContentPushCount: vi.fn(() => pushes),
      });
      const send = useSharedRounds();
      send.mockImplementation(() => {
        pushes++;
        return createEmptyStream();
      });
      send.mockImplementationOnce(() =>
        (async function* () {
          pushes++;
          yield text('first part');
          yield finished(FinishReason.MAX_TOKENS, {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
          });
          // The client's next-speaker check sends "Please continue."
          pushes++;
          yield toolCall({
            id: 'call-write',
            name: 'write_file',
            args: { file_path: '/tmp/notes.txt', content: 'all of it' },
          });
          yield finished(FinishReason.STOP, {
            promptTokenCount: 20,
            candidatesTokenCount: 6,
          });
        })(),
      );
      const emitUsage = vi.spyOn(
        (
          session as unknown as {
            messageEmitter: {
              emitUsageMetadata: (...args: unknown[]) => Promise<void>;
            };
          }
        ).messageEmitter,
        'emitUsageMetadata',
      );

      await prompt();

      // The first response's cut does not refuse the continuation's edit.
      expect(execute).toHaveBeenCalledOnce();
      // Each response reports its own usage.
      expect(
        emitUsage.mock.calls.map(
          ([usage]) =>
            (usage as { candidatesTokenCount?: number }).candidatesTokenCount,
        ),
      ).toEqual([4, 6]);
    });

    it.each([
      [
        'the session token limit',
        {
          type: core.LlmEventType.SessionTokenLimitExceeded,
          value: { currentTokens: 120, limit: 100, message: 'over' },
        },
        'max_tokens',
      ],
      [
        'the session turn limit',
        { type: core.LlmEventType.MaxSessionTurns },
        'max_turn_requests',
      ],
    ] as const)('ends the prompt at %s', async (_name, event, stopReason) => {
      useSharedRounds([event as RoundEvent]);

      const result = await prompt();

      expect(result.stopReason).toBe(stopReason);
    });

    it('rejects a prompt whose model round the client stopped as a loop', async () => {
      useSharedRounds([
        {
          type: core.LlmEventType.LoopDetected,
          value: {
            loopType: core.LoopType.CHANTING_IDENTICAL_SENTENCES,
          },
        },
      ]);

      await expect(prompt()).rejects.toMatchObject({
        code: -32603,
        data: expect.objectContaining({
          code: 'LOOP_DETECTED',
          loopType: core.LoopType.CHANTING_IDENTICAL_SENTENCES,
        }),
      });
    });

    function useStopHook(decisions: Array<Record<string, unknown>>) {
      const request = vi.fn().mockImplementation(async (message) => ({
        success: true,
        output:
          message.eventName === 'Stop' ? (decisions.shift() ?? {}) : undefined,
      }));
      mockConfig.getMessageBus = vi.fn().mockReturnValue({ request });
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((eventName: string) => eventName === 'Stop');
      return request;
    }
    const stopRequests = (request: ReturnType<typeof vi.fn>) =>
      request.mock.calls.filter(([message]) => message.eventName === 'Stop');

    it('leaves the Stop hook to the client, with the Todo Stop Guard as its stop policy', async () => {
      const send = useSharedRounds([text('done'), finished()]);
      const request = useStopHook([]);

      await prompt();

      const options = send.mock.calls[0][3];
      expect(options).not.toHaveProperty('stopHookRunByHost');
      expect(options.stopPolicies).toHaveLength(1);
      // The client fires the Stop hook; the session fires none of its own.
      expect(stopRequests(request)).toHaveLength(0);
    });

    it("reports the client's Stop hook messages, the loop from its second block on", async () => {
      useSharedRounds([
        text('first'),
        finished(),
        { type: core.LlmEventType.HookSystemMessage, value: 'hook says hi' },
        {
          type: core.LlmEventType.StopHookLoop,
          value: { iterationCount: 1, reasons: ['a'], stopHookCount: 1 },
        },
        text('second'),
        finished(),
        {
          type: core.LlmEventType.StopHookLoop,
          value: { iterationCount: 2, reasons: ['a', 'b'], stopHookCount: 1 },
        },
        text('third'),
        finished(),
      ]);

      await prompt();

      expect(agentText()).toContain('hook says hi');
      const loops = updates().filter(
        (update) =>
          (update as { _meta?: Record<string, unknown> })._meta?.[
            'stopHookLoop'
          ] !== undefined,
      );
      expect(loops).toEqual([
        expect.objectContaining({
          _meta: {
            stopHookLoop: {
              iterationCount: 2,
              reasons: ['a', 'b'],
              stopHookCount: 1,
            },
          },
        }),
      ]);
    });

    it('runs completion memory work when the client ends at the Stop hook cap', async () => {
      const send = useSharedRounds();
      send.mockImplementationOnce(
        (
          _parts: Part[],
          _signal: AbortSignal,
          _promptId: string,
          options: { stopPolicies?: core.StopPolicy[] },
        ) =>
          (async function* () {
            yield text('not done');
            yield finished();
            for (const policy of options.stopPolicies ?? []) {
              policy.onStopHookCap?.();
            }
            // The client returns at the cap before scheduling memory tasks.
            yield {
              type: core.LlmEventType.HookSystemMessage,
              value:
                'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
            };
          })(),
      );

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(
        mockLlmClient.runManagedAutoMemoryBackgroundTasks,
      ).toHaveBeenCalledExactlyOnceWith(core.SendMessageType.UserQuery);
    });

    it.each(['Stop hook', 'Todo Stop Guard'])(
      'records only the final answer after a %s continuation',
      async (continuation) => {
        const send = useSharedRounds();
        let pushes = 0;
        Object.assign(mockChat, {
          getUserContentPushCount: vi.fn(() => pushes),
        });
        send.mockImplementationOnce(() =>
          (async function* () {
            pushes++;
            yield text('Superseded answer.');
            yield finished();
            if (continuation === 'Stop hook') {
              yield {
                type: core.LlmEventType.StopHookLoop,
                value: {
                  iterationCount: 1,
                  reasons: ['Finish the requested work'],
                  stopHookCount: 1,
                },
              };
            }
            pushes++;
            yield text('Final answer.');
            yield finished();
          })(),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'finish the work' }],
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'daemon-stop-continuation',
          },
        );

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledWith(
          expect.objectContaining({
            state: 'completed',
            resultText: 'Final answer.',
          }),
          'test-session-id########1',
        );
      },
    );

    it('gives a Stop hook continuation a fresh host-owned tool budget with Live tools', async () => {
      const execute = useTool(core.Kind.Read, 'read_file');
      const registered = new Map<string, core.AnyDeclarativeTool>();
      registered.set('read_file', mockToolRegistry.getTool('read_file'));
      mockToolRegistry.registerTool = vi.fn((tool) => {
        registered.set(tool.name, tool);
      });
      mockToolRegistry.getTool = vi.fn((name: string) => registered.get(name));
      await session.enableLiveScreenContext();
      useStopHook([{ decision: 'block', reason: 'Check the other file' }]);
      mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
      mockConfig.isMaxToolCallsPerTurnExplicit = vi.fn().mockReturnValue(true);
      const send = useSharedRounds(
        [
          toolCall({
            id: 'before-stop',
            name: 'read_file',
            args: { file_path: '/tmp/before.txt' },
          }),
          finished(),
        ],
        [
          text('Initial answer.'),
          finished(),
          {
            type: core.LlmEventType.StopHookLoop,
            value: {
              iterationCount: 1,
              reasons: ['Check the other file'],
              stopHookCount: 1,
            },
          },
          toolCall({
            id: 'after-stop',
            name: 'read_file',
            args: { file_path: '/tmp/after.txt' },
          }),
          finished(),
        ],
        [text('Final answer.'), finished()],
      );

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(send.mock.calls[0][3]).toMatchObject({
        toolLoopGuardsByHost: true,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(runAcpToolBatchSpy).not.toHaveBeenCalled();
    });

    it("leaves the turn's background results that arrive after its response to a notification turn", async () => {
      const send = useSharedRounds();
      send.mockImplementationOnce(() =>
        (async function* () {
          yield text('started the worker');
          (
            mockBackgroundTaskRegistry.setNotificationCallback.mock
              .calls[0][0] as (
              display: string,
              model: string,
              meta: { agentId: string; status: string; sourceTurnId?: string },
            ) => void
          )('worker complete', 'WORKER_RESULT', {
            agentId: 'worker',
            status: 'completed',
            sourceTurnId: 'test-session-id########1',
          });
          yield finished();
        })(),
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockImplementation(async () => createEmptyStream());

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      // The prompt ends with its response, as the client's stop point does,
      // and the result starts a notification turn of its own.
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
      expect(send.mock.calls[1][0]).toContainEqual({ text: 'WORKER_RESULT' });
      expect(send.mock.calls[1][2]).toContain('notification');
      expect(send.mock.calls[1][3]).toMatchObject({
        type: core.SendMessageType.Notification,
      });
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    });

    describe('the Todo Stop Guard as a stop policy', () => {
      const pendingTodos = {
        type: 'todo_list',
        todos: [{ id: 'task-1', content: 'finish task', status: 'pending' }],
      };

      /** A session whose guard is on, with a way to arm it. */
      function useGuardSession() {
        session.dispose();
        (
          mockSettings as unknown as { merged: Record<string, unknown> }
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
        const send = useSharedRounds([text('done'), finished()]);
        const guard = (
          session as unknown as {
            todoStopGuard: {
              observeTodoWrite(display: unknown, allowArm: boolean): boolean;
            };
          }
        ).todoStopGuard;
        return { send, arm: () => guard.observeTodoWrite(pendingTodos, true) };
      }

      /** The policy the round handed the client. */
      const policyOf = (send: ReturnType<typeof vi.fn>) =>
        send.mock.calls[0][3].stopPolicies[0] as core.StopPolicy;
      const stop = () => ({
        promptId: 'test-session-id########1',
        signal: new AbortController().signal,
      });

      it('continues while todos remain, then stops once its attempts are spent', async () => {
        const { send, arm } = useGuardSession();
        await prompt();
        const policy = policyOf(send);
        arm();

        const first = await policy.continueAt(stop());
        const second = await policy.continueAt(stop());
        const third = await policy.continueAt(stop());

        expect(first?.[0]?.text).toContain('[Todo Stop Guard] 1 todo item(s)');
        expect(second?.[0]?.text).toContain('final automatic continuation');
        expect(third).toBeUndefined();
        expect(agentText()).toEqual(
          expect.arrayContaining([
            expect.stringContaining('Automatic continuation 1/2 started'),
            expect.stringContaining('Automatic continuation stopped after 2'),
          ]),
        );
      });

      it('yields to a prompt the host has queued', async () => {
        const { send, arm } = useGuardSession();
        await prompt();
        const policy = policyOf(send);
        arm();
        mockClient.extMethod = vi.fn().mockResolvedValue({
          claimed: false,
          hasQueuedPrompt: true,
        });

        expect(await policy.continueAt(stop())).toBeUndefined();
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
          expect.anything(),
        );
      });

      it('stops for good when the Stop hook cap ends the turn', async () => {
        const { send, arm } = useGuardSession();
        await prompt();
        const policy = policyOf(send);
        arm();

        policy.onStopHookCap?.();

        expect(await policy.continueAt(stop())).toBeUndefined();
      });
    });

    it('shows the calls of a round the loop guard stopped as skipped', async () => {
      const execute = useTool(core.Kind.Read, 'read_file');
      useSharedRounds([
        {
          type: core.LlmEventType.ToolCallPreparation,
          value: { callId: 'call-read', toolName: 'read_file' },
        },
        toolCall({ id: 'call-read', name: 'read_file', args: {} }),
        { type: core.LlmEventType.LoopDetected },
      ]);

      await expect(prompt()).rejects.toMatchObject({ code: -32603 });

      expect(execute).not.toHaveBeenCalled();
      expect(updates()).toContainEqual(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-read',
          status: 'failed',
          content: [
            expect.objectContaining({
              content: expect.objectContaining({
                text: 'Skipped because loop detection stopped the current turn before this tool call could run.',
              }),
            }),
          ],
        }),
      );
      expect(updates()).not.toContainEqual(
        expect.objectContaining({
          _meta: expect.objectContaining({ preparationDiscarded: true }),
        }),
      );
    });

    const readCall = (id: string) =>
      toolCall({ id, name: 'read_file', args: { file_path: '/tmp/a.txt' } });

    it('stops the turn on its third parameter error from one tool, as its own guard does', async () => {
      useTool(core.Kind.Read, 'read_file');
      runAcpToolBatchSpy.mockImplementation(
        async (
          _host: unknown,
          { requests }: { requests: core.ToolCallRequestInfo[] },
        ) => {
          const results = requests.map((request) => ({
            request,
            executionRequest: request,
            response: {
              callId: request.callId,
              responseParts: [
                {
                  functionResponse: {
                    id: request.callId,
                    name: request.name,
                    response: { error: 'bad params' },
                  },
                },
              ],
              error: new Error('bad params'),
              errorType: core.ToolErrorType.INVALID_TOOL_PARAMS,
              executionStatus: 'not_started',
            },
            status: 'error',
            origin: 'executed',
          }));
          return {
            parts: results.flatMap(({ response }) => response.responseParts),
            results,
            stopAfterPermissionCancel: false,
          };
        },
      );
      const send = useSharedRounds(
        [readCall('call-1'), finished()],
        [readCall('call-2'), finished()],
        [readCall('call-3'), finished()],
        [text('never'), finished()],
      );

      await expect(prompt()).rejects.toMatchObject({
        data: expect.objectContaining({
          loopType: core.LoopType.INVALID_TOOL_PARAMS_STAGNATION,
        }),
      });

      expect(send).toHaveBeenCalledTimes(3);
    });

    it('ends the turn when a permission request is cancelled', async () => {
      useTool(core.Kind.Edit, 'write_file');
      runAcpToolBatchSpy.mockResolvedValue({
        parts: [],
        results: [],
        stopAfterPermissionCancel: true,
      });
      const send = useSharedRounds([
        toolCall({ id: 'call-write', name: 'write_file', args: {} }),
        finished(),
      ]);

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      expect(send).toHaveBeenCalledOnce();
    });

    it('ends the turn when a tool asks to end it', async () => {
      useTool(core.Kind.Other, 'goal_checkpoint');
      runAcpToolBatchSpy.mockImplementation(
        async (
          host: unknown,
          options: { requests: core.ToolCallRequestInfo[] },
        ) => ({
          ...(await runEachTool(host, options)),
          stop: 'tool_ended_turn',
        }),
      );
      const send = useSharedRounds([
        toolCall({ id: 'call-end', name: 'goal_checkpoint', args: {} }),
        finished(),
      ]);

      const result = await prompt();

      expect(result.stopReason).toBe('end_turn');
      expect(send).toHaveBeenCalledOnce();
    });

    it('refuses a Goal approval the turn cannot own', async () => {
      useTool(core.Kind.Read, 'read_file');
      useSharedRounds([readCall('call-read'), finished()]);

      await prompt();

      const host = runAcpToolBatchSpy.mock.calls[0][0] as {
        refuseToolCall: (request: object) => string | undefined;
      };
      expect(
        host.refuseToolCall({
          callId: 'call-goal',
          name: 'propose_goal',
          args: {},
          prompt_id: 'test-session-id########1',
        }),
      ).toContain('this turn cannot own a Goal approval');
      expect(
        host.refuseToolCall({
          callId: 'call-read',
          name: 'read_file',
          args: {},
          prompt_id: 'test-session-id########1',
        }),
      ).toBeUndefined();
    });

    it('throws the error the provider threw', async () => {
      const providerError = Object.assign(new Error('upstream exploded'), {
        status: 500,
        code: 'upstream_failure',
      });
      const structured: core.StructuredError = {
        message: 'friendly text',
        status: 500,
      };
      structuredErrorCauses.set(structured, providerError);
      useSharedRounds([]);
      let clientFinished = false;
      Object.assign(mockLlmClient, {
        sendMessageStream: vi.fn(() =>
          (async function* () {
            yield {
              type: core.LlmEventType.Error,
              value: { error: structured },
            };
            // The client's own work after an error, such as ending the turn.
            clientFinished = true;
          })(),
        ),
      });

      await expect(prompt()).rejects.toBe(providerError);
      expect(clientFinished).toBe(true);
    });

    describe('a turn it re-enters', () => {
      const promptId = 'test-session-id########7';
      let orphan: Content;

      beforeEach(() => {
        orphan = { role: 'user', parts: [{ text: 'unanswered' }] };
        markApiHistoryPrompt(orphan, promptId);
        vi.mocked(mockChat.getHistory).mockReturnValue([orphan]);
        vi.mocked(mockChat.stripOrphanedUserEntriesFromHistory).mockReturnValue(
          [orphan],
        );
      });

      const reenter = (mode: 'retry' | 'continue') =>
        session.prompt({
          sessionId: 'test-session-id',
          prompt:
            mode === 'retry' ? [{ type: 'text', text: 'unanswered' }] : [],
          _meta: {
            [mode === 'retry'
              ? 'qwen.daemon.retry'
              : 'qwen.daemon.continueLastTurn']: true,
          },
        });

      it.each(['retry', 'continue'] as const)(
        'resends through %s as a Retry with the stripped prompt identity',
        async (mode) => {
          const send = useSharedRounds([text('done'), finished()]);
          const admit = (
            mockLlmClient as unknown as {
              admitUserPrompt: ReturnType<typeof vi.fn>;
            }
          ).admitUserPrompt;

          await reenter(mode);

          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
          expect(send).toHaveBeenCalledOnce();
          expect(send.mock.calls[0][3]).toMatchObject({
            type: core.SendMessageType.Retry,
            userTurnRecordedByHost: true,
            historyPromptId: promptId,
          });
          // A retry runs UserPromptSubmit, as before; a continue does not.
          if (mode === 'retry') {
            expect(admit).toHaveBeenCalledOnce();
            expect(send.mock.calls[0][3]).toMatchObject({
              promptAdmission: { blocked: false },
            });
          } else {
            expect(admit).not.toHaveBeenCalled();
            expect(send.mock.calls[0][3]).not.toHaveProperty('promptAdmission');
          }
          expect(
            mockChatRecordingService.recordUserMessage,
          ).not.toHaveBeenCalled();
        },
      );

      it('keeps one copy of a retry cancelled before its request went out', async () => {
        Object.assign(mockChat, { getUserContentPushCount: vi.fn(() => 0) });
        const send = useSharedRounds();
        send.mockImplementationOnce(() =>
          (async function* () {
            await session.cancelPendingPrompt();
            yield { type: core.LlmEventType.UserCancelled };
          })(),
        );

        await expect(reenter('retry')).resolves.toMatchObject({
          stopReason: 'cancelled',
        });

        // The prompt puts the stripped attempt back; the unsent resend is not
        // kept beside it.
        expect(vi.mocked(mockChat.addHistory).mock.calls).toEqual([[orphan]]);
      });

      it.each(['retry', 'continue'] as const)(
        'puts the stripped prompt back once when %s fails before sending',
        async (mode) => {
          // The request never reached history.
          Object.assign(mockChat, { getUserContentPushCount: vi.fn(() => 0) });
          const send = useSharedRounds();
          send.mockImplementationOnce(() =>
            // eslint-disable-next-line require-yield
            (async function* () {
              throw new Error('request failed before it went out');
            })(),
          );

          await expect(reenter(mode)).rejects.toThrow('before it went out');

          const restored = vi
            .mocked(mockChat.addHistory)
            .mock.calls.filter(([entry]) => entry === orphan);
          expect(restored).toHaveLength(1);
          expect(
            vi
              .mocked(mockChat.addHistory)
              .mock.calls.filter(([entry]) => entry !== orphan),
          ).toEqual([]);
        },
      );

      it('does not put a retry back once its request reached history and its response failed', async () => {
        let pushes = 0;
        Object.assign(mockChat, {
          getUserContentPushCount: vi.fn(() => pushes),
        });
        const send = useSharedRounds();
        send.mockImplementationOnce(() =>
          (async function* () {
            // LlmChat pushed the retry's user entry, then the model failed.
            pushes = 1;
            yield {
              type: core.LlmEventType.Error,
              value: { error: { message: 'model failed again', status: 500 } },
            };
          })(),
        );

        await expect(reenter('retry')).rejects.toThrow();

        expect(mockChat.addHistory).not.toHaveBeenCalledWith(orphan);
      });

      it('puts a continue back as it was, with its worktree notice pending, when cancelled before its first request', async () => {
        Object.assign(mockChat, { getUserContentPushCount: vi.fn(() => 0) });
        const send = useSharedRounds([text('done'), finished()]);
        session.pendingWorktreeNotice = 'the worktree is still alive';
        // The turn is cancelled while it builds its first message.
        vi.mocked(mockConfig.takeActiveTodoReminder).mockImplementationOnce(
          () => {
            void session.cancelPendingPrompt();
            return undefined;
          },
        );

        await expect(reenter('continue')).resolves.toMatchObject({
          stopReason: 'cancelled',
        });

        expect(send).not.toHaveBeenCalled();
        expect(vi.mocked(mockChat.addHistory).mock.calls).toEqual([[orphan]]);
        expect(session.pendingWorktreeNotice).toBe(
          'the worktree is still alive',
        );
      });

      it('keeps the worktree notice pending when a continue fails before sending', async () => {
        Object.assign(mockChat, { getUserContentPushCount: vi.fn(() => 0) });
        const send = useSharedRounds();
        send.mockImplementationOnce(() =>
          // eslint-disable-next-line require-yield
          (async function* () {
            throw new Error('request failed before it went out');
          })(),
        );
        session.pendingWorktreeNotice = 'the worktree is still alive';

        await expect(reenter('continue')).rejects.toThrow('before it went out');

        expect(session.pendingWorktreeNotice).toBe(
          'the worktree is still alive',
        );
      });

      it('gives a Retry round the session reminders the client leaves to it', async () => {
        const send = useSharedRounds([text('done'), finished()]);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);

        await reenter('retry');

        const parts = send.mock.calls[0][0] as Part[];
        expect(
          parts.some(
            (part) =>
              typeof part.text === 'string' &&
              part.text.includes('<system-reminder>') &&
              /plan mode/i.test(part.text),
          ),
        ).toBe(true);
      });
    });

    describe('cron and background-notification turns', () => {
      /**
       * Runs each round on the mocked client; a round pushes its request
       * unless told not to, and runs `afterEvents` once its events are out.
       */
      function automaticRounds(
        events: (index: number) => RoundEvent[] = () => [],
        pushes: (index: number) => boolean = () => true,
        afterEvents: (index: number) => Promise<void> | void = () => {},
      ) {
        const sends: Array<
          [Part[], AbortSignal, string, Record<string, unknown>]
        > = [];
        let pushCount = 0;
        mockConfig.isUnifiedAgentLoopEnabled = vi.fn().mockReturnValue(true);
        Object.assign(mockChat, {
          getUserContentPushCount: vi.fn(() => pushCount),
        });
        Object.assign(mockLlmClient, {
          admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
          finishManagedAutoMemoryRecall: vi.fn(),
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
                if (pushes(index)) pushCount++;
                for (const event of events(index)) yield event;
                await afterEvents(index);
              })();
            },
          ),
        });
        mockChat.sendMessageStream = vi.fn();
        return sends;
      }

      /** Fires one in-session cron job once the session starts its scheduler. */
      function fireCron(prompt: string, job: object = {}) {
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue({
          size: 1,
          hasPendingWork: true,
          start: vi.fn((callback: (job: { prompt: string }) => void) =>
            callback({ prompt, ...job }),
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        });
      }

      const notify = () =>
        session.enqueueBackgroundNotification({
          displayText: 'Agent completed.',
          modelText: '<task-notification />',
          taskId: 'task-1',
          status: 'completed',
          kind: 'agent',
        });

      const backgroundResponses = () =>
        updates().filter(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            (update._meta as { source?: string } | undefined)?.source ===
              'background_notification_response',
        );

      it('runs a cron fire as a Cron round and records its prompt once sent', async () => {
        fireCron('nightly report');
        const sends = automaticRounds((index) =>
          index === 1 ? [text('cron result'), finished()] : [finished()],
        );

        await prompt();
        await vi.waitFor(() =>
          expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalled(),
        );

        expect(sends[1][0]).toEqual([{ text: 'nightly report' }]);
        expect(sends[1][3]).toMatchObject({
          type: core.SendMessageType.Cron,
          userTurnRecordedByHost: true,
          interactionSpanByHost: true,
          toolCallPreparations: true,
        });
        expect(sends[1][3]['stopPolicies']).toHaveLength(1);
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledWith(
          [{ text: 'nightly report' }],
          'nightly report',
        );
        await vi.waitFor(() => expect(agentText()).toContain('cron result'));
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      });

      it('records a cron prompt before the response its round records', async () => {
        fireCron('nightly report');
        const order: string[] = [];
        mockChatRecordingService.recordCronPrompt.mockImplementation(() => {
          order.push('cron prompt');
        });
        // The client records a response once its stream ends.
        automaticRounds(
          (index) =>
            index === 1 ? [text('cron result'), finished()] : [finished()],
          () => true,
          (index) => {
            if (index === 1) order.push('cron response');
          },
        );

        await prompt();
        await vi.waitFor(() => expect(order).toContain('cron response'));

        expect(order).toEqual(['cron prompt', 'cron response']);
      });

      describe('scheduled delivery', () => {
        const scheduledJob = {
          id: 'task-1',
          lastFiredAt: 1_750_000_000_000,
          delivery: {
            kind: 'channel',
            target: { channelName: 'dingtalk', type: 'chat', id: 'chat-1' },
          },
        };
        const deliveries = () =>
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.filter(
              ([method]) => method === 'qwen/control/channel-delivery',
            );

        it('delivers a scheduled cron turn that ended on its own', async () => {
          fireCron('nightly report', scheduledJob);
          automaticRounds((index) =>
            index === 1 ? [text('cron result'), finished()] : [finished()],
          );

          await prompt();

          await vi.waitFor(() => expect(deliveries()).toHaveLength(1));
          expect(deliveries()[0][1]).toMatchObject({
            deliveryId: 'task-1:1750000000000',
            text: 'cron result',
          });
        });

        it('does not deliver a scheduled cron turn loop protection stopped', async () => {
          fireCron('nightly report', scheduledJob);
          automaticRounds((index) =>
            index === 1
              ? [
                  text('looping'),
                  {
                    type: core.LlmEventType.LoopDetected,
                    value: {
                      loopType: core.LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
                    },
                  } as RoundEvent,
                ]
              : [finished()],
          );

          await prompt();
          await vi.waitFor(() =>
            expect(
              mockLlmClient.finishManagedAutoMemoryRecall,
            ).toHaveBeenCalled(),
          );
          // Delivery is submitted on the next tick.
          await new Promise((resolve) => setTimeout(resolve, 20));

          expect(deliveries()).toHaveLength(0);
        });
      });

      it('ends a cron turn cancelled mid-response as cancelled, not as a failure', async () => {
        fireCron('nightly report');
        const fireStopFailureEvent = vi.fn().mockResolvedValue(undefined);
        mockConfig.getHookSystem = vi.fn().mockReturnValue({
          fireStopFailureEvent,
        });
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((name: string) => name === 'StopFailure');
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        automaticRounds(
          (index) => (index === 1 ? [text('cron partial')] : [finished()]),
          () => true,
          async (index) => {
            if (index !== 1) return;
            await released;
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          },
        );

        await prompt();
        await vi.waitFor(() => expect(agentText()).toContain('cron partial'));
        await session.cancelPendingPrompt();
        release();
        await vi.waitFor(() =>
          expect(
            mockLlmClient.finishManagedAutoMemoryRecall,
          ).toHaveBeenCalled(),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fireStopFailureEvent).not.toHaveBeenCalled();
        expect(agentText()).not.toContain('cron error');
      });

      it('keeps a cron prompt whose request never went out out of the record', async () => {
        fireCron('nightly report');
        const sends = automaticRounds(
          () => [finished()],
          (index) => index !== 1,
        );

        await prompt();
        await vi.waitFor(() => expect(sends).toHaveLength(2));
        await vi.waitFor(() =>
          expect(
            mockLlmClient.finishManagedAutoMemoryRecall,
          ).toHaveBeenCalled(),
        );

        expect(
          mockChatRecordingService.recordCronPrompt,
        ).not.toHaveBeenCalled();
      });

      it("sends a cron fire's tool results back as a ToolResult round", async () => {
        fireCron('nightly report');
        const execute = useTool(core.Kind.Read, 'read_file');
        const sends = automaticRounds((index) =>
          index === 1
            ? [
                toolCall({ id: 'call-1', name: 'read_file', args: {} }),
                finished(),
              ]
            : [finished()],
        );

        await prompt();
        await vi.waitFor(() => expect(sends).toHaveLength(3));

        expect(execute).toHaveBeenCalledOnce();
        expect(sends[2][3]).toMatchObject({
          type: core.SendMessageType.ToolResult,
          interactionSpanByHost: true,
        });
        expect(sends[2][3]).not.toHaveProperty('userTurnRecordedByHost');
        expect(sends[2][0]).toContainEqual(
          expect.objectContaining({
            functionResponse: expect.objectContaining({ id: 'call-1' }),
          }),
        );
      });

      it('runs a background notification as a Notification round and shows its response once', async () => {
        const sends = automaticRounds(() => [
          text('agent '),
          text('done'),
          finished(),
        ]);

        await notify();
        await vi.waitFor(() =>
          expect(
            backgroundResponses().some(
              (update) =>
                (
                  update._meta as {
                    backgroundTask?: { turnComplete?: boolean };
                  }
                ).backgroundTask?.turnComplete === true,
            ),
          ).toBe(true),
        );

        expect(sends).toHaveLength(1);
        expect(sends[0][3]).toMatchObject({
          type: core.SendMessageType.Notification,
          userTurnRecordedByHost: true,
        });
        expect(sends[0][3]).not.toHaveProperty('interactionSpanByHost');
        expect(sends[0][0]).toContainEqual({ text: '<task-notification />' });
        expect(
          backgroundResponses().map(
            (update) => (update.content as { text: string }).text,
          ),
        ).toEqual(['agent done', '']);
        // Not streamed piece by piece as a prompt's response is.
        expect(agentText()).not.toContain('agent ');
      });

      it('ends a notification turn that loop protection stopped as partial', async () => {
        automaticRounds(() => [
          text('looping'),
          {
            type: core.LlmEventType.LoopDetected,
            value: { loopType: core.LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS },
          } as RoundEvent,
        ]);

        await notify();
        await vi.waitFor(() =>
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            expect.objectContaining({ source: 'background_notification' }),
          ),
        );

        const last = backgroundResponses().at(-1)!;
        expect(
          (
            last._meta as {
              backgroundTask: { turnComplete?: boolean; partial?: boolean };
            }
          ).backgroundTask,
        ).toMatchObject({ turnComplete: true, partial: true });
      });
    });
  });

  describe('Managed Runtime batch close', () => {
    function driveToolTurn() {
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'hi',
        returnDisplay: 'hi',
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: 'run_shell_command',
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue({
          params: { command: 'echo hi' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('echo hi'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute,
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-shell-1',
                    name: 'run_shell_command',
                    args: { command: 'echo hi' },
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());
      return execute;
    }

    it('flushes the recorded results and closes the continuation in that order', async () => {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockChatRecordingService.recordToolResult.mockImplementation(() => {
        order.push('recordToolResult');
      });
      mockChatRecordingService.flush.mockImplementation(async () => {
        order.push('flush');
        await gate;
      });
      const finalizeBatch = vi.fn().mockImplementation(async () => {
        order.push('finalizeBatch');
      });
      mockConfig.getManagedRuntimeOutcomes = vi.fn().mockReturnValue({
        finalizeBatch,
      });
      const execute = driveToolTurn();
      const sendSpy = mockChat.sendMessageStream;
      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run it' }],
      });

      await vi.waitFor(() =>
        expect(mockChatRecordingService.flush).toHaveBeenCalled(),
      );
      // A fire-and-forget close could not hold it: while the flush is
      // uncommitted the model is never asked again.
      await new Promise((resolve) => setImmediate(resolve));
      expect(execute).toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledTimes(1);
      release();
      await prompt;
      expect(order).toEqual(['recordToolResult', 'flush', 'finalizeBatch']);
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(2));
    });

    it('degrades a latched recording failure without closing the batch', async () => {
      // ChatRecordingService latches a write failure permanently, so every
      // later flush re-throws it; the close must not follow a flush whose
      // records never landed, and the turn must still reach the model.
      mockChatRecordingService.flush.mockRejectedValueOnce(
        new Error('transcript lease taken over'),
      );
      const finalizeBatch = vi.fn().mockResolvedValue(undefined);
      mockConfig.getManagedRuntimeOutcomes = vi.fn().mockReturnValue({
        finalizeBatch,
      });
      const execute = driveToolTurn();
      const sendSpy = mockChat.sendMessageStream;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run it' }],
      });

      expect(execute).toHaveBeenCalled();
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(2));
      expect(finalizeBatch).not.toHaveBeenCalled();
    });

    it('runs neither for a Legacy session', async () => {
      const order: string[] = [];
      mockChatRecordingService.flush.mockImplementation(async () => {
        order.push('flush');
      });
      mockConfig.getManagedRuntimeOutcomes = vi.fn().mockReturnValue(undefined);
      const execute = driveToolTurn();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run it' }],
      });

      expect(execute).toHaveBeenCalled();
      expect(order).toEqual([]);
    });
  });

  describe('managed auto-memory', () => {
    it('recalls before the initial send and schedules background work after a successful turn', async () => {
      const memoryPrompt = '<system-reminder>remember this</system-reminder>';
      const finalHistory: Content[] = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'response' }] },
      ];
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce({
        prompt: memoryPrompt,
        selectedDocs: [],
        strategy: 'heuristic',
      });
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(finalHistory);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(mockLlmClient.beginManagedAutoMemoryRecall).toHaveBeenCalledWith(
        'hello',
        expect.any(AbortSignal),
      );
      expect(
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn,
      ).toHaveBeenCalledOnce();
      expect(textParts(firstSentMessage())).toEqual([memoryPrompt, 'hello']);
      expect(mockMemoryManager.scheduleMetadataMigration).toHaveBeenCalledTimes(
        2,
      );
      expect(mockMemoryManager.scheduleMetadataMigration).toHaveBeenCalledWith({
        projectRoot: '/repo',
        scope: 'project',
        config: mockConfig,
      });
      expect(mockMemoryManager.scheduleMetadataMigration).toHaveBeenCalledWith({
        projectRoot: '/repo',
        scope: 'user',
        config: mockConfig,
      });

      // Captured twice: once inside `#recordPromptCompletionEffects` (before
      // `scheduleExtract`, pinned below) and once at the turn boundary that
      // feeds the follow-up suggestion.
      expect(mockLlmClient.captureCacheSafeParams).toHaveBeenCalledTimes(2);
      expect(
        mockLlmClient.captureCacheSafeParams.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockMemoryManager.scheduleExtract.mock.invocationCallOrder[0]!,
      );
      expect(mockMemoryManager.scheduleExtract).toHaveBeenCalledWith({
        projectRoot: '/repo',
        sessionId: 'test-session-id',
        history: finalHistory,
        config: mockConfig,
      });
      expect(mockMemoryManager.scheduleExtract).toHaveBeenCalledOnce();
      expect(mockMemoryManager.scheduleDream).toHaveBeenCalledWith({
        projectRoot: '/repo',
        sessionId: 'test-session-id',
        config: mockConfig,
      });
      expect(mockMemoryManager.scheduleDream).toHaveBeenCalledOnce();
      expect(
        mockLlmClient.finishManagedAutoMemoryRecall,
      ).toHaveBeenCalledOnce();
    });

    it('drives the prepared recall-mode transition before the per-turn reset on a fresh user turn', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(
        mockLlmClient.activatePreparedMemoryRecallTransition,
      ).toHaveBeenCalledOnce();
      const activationOrder =
        mockLlmClient.activatePreparedMemoryRecallTransition.mock
          .invocationCallOrder[0]!;
      expect(activationOrder).toBeLessThan(
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn.mock
          .invocationCallOrder[0]!,
      );
      expect(activationOrder).toBeLessThan(
        mockLlmClient.beginManagedAutoMemoryRecall.mock.invocationCallOrder[0]!,
      );
    });

    it('delivers refined recall after tool responses and records the completed tool', async () => {
      const memoryPrompt = '<system-reminder>refined memory</system-reminder>';
      mockLlmClient.consumeManagedAutoMemoryRecall
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          prompt: memoryPrompt,
          selectedDocs: [],
          strategy: 'model',
        });
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      mockToolRegistry.getTool.mockReturnValue({
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
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
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

      const followUpRequest = vi.mocked(mockChat.sendMessageStream).mock
        .calls[1]?.[1] as { message: Part[] };
      const followUp = followUpRequest.message;
      expect(followUp[0]?.functionResponse).toBeDefined();
      expect(textParts(followUp)).toEqual([memoryPrompt]);
      expect(
        mockLlmClient.consumeManagedAutoMemoryRecall,
      ).toHaveBeenNthCalledWith(2, 'tool_result');
      expect(mockLlmClient.recordCompletedToolCall).toHaveBeenCalledWith(
        'read_file',
        { path: '/tmp/test.txt' },
      );
      expect(
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn,
      ).toHaveBeenCalledOnce();
    });

    it('does not run managed memory for retries or failed turns', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'retry' }],
        retry: true,
      } as PromptRequest);

      expect(mockLlmClient.beginManagedAutoMemoryRecall).not.toHaveBeenCalled();
      expect(
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn,
      ).not.toHaveBeenCalled();
      expect(mockMemoryManager.scheduleExtract).not.toHaveBeenCalled();
      expect(mockMemoryManager.scheduleDream).not.toHaveBeenCalled();
      // A retry skips managed auto-memory, but the turn still ends `end_turn`,
      // so the follow-up suggestion fires and reads the process-global
      // cache-safe slot. The turn boundary has to refresh it anyway, or the
      // suggestion is generated from a transcript missing this turn.
      expect(mockLlmClient.captureCacheSafeParams).toHaveBeenCalledOnce();

      mockChat.sendMessageStream = vi
        .fn()
        .mockRejectedValueOnce(new Error('provider failed'));
      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'new request' }],
        }),
      ).rejects.toThrow('provider failed');

      expect(mockLlmClient.beginManagedAutoMemoryRecall).toHaveBeenCalledOnce();
      expect(mockMemoryManager.scheduleExtract).not.toHaveBeenCalled();
      expect(mockMemoryManager.scheduleDream).not.toHaveBeenCalled();
      // A failed turn never reaches the success path, so it must not publish
      // its partial transcript as cache-safe.
      expect(mockLlmClient.captureCacheSafeParams).toHaveBeenCalledOnce();
      expect(
        mockLlmClient.finishManagedAutoMemoryRecall,
      ).toHaveBeenCalledOnce();
    });

    it('commits delivery after the final response attempt completes', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield { type: core.StreamEventType.RETRY } as const;
          expect(
            mockLlmClient.commitManagedAutoMemoryRecallDelivery,
          ).not.toHaveBeenCalled();
          yield {
            type: core.StreamEventType.CHUNK,
            value: { text: 'ok' },
          } as const;
          expect(
            mockLlmClient.commitManagedAutoMemoryRecallDelivery,
          ).not.toHaveBeenCalled();
        })(),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledOnce();
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
      expect(
        mockLlmClient.discardManagedAutoMemoryRecallDelivery,
      ).not.toHaveBeenCalled();
    });

    it('commits delivery when the user cancels after a response chunk', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      let firstChunkConsumed!: () => void;
      const consumed = new Promise<void>((resolve) => {
        firstChunkConsumed = resolve;
      });
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'partial' }] } }],
            },
          } as const;
          firstChunkConsumed();
          await streamGate;
          yield {
            type: core.StreamEventType.CHUNK,
            value: { text: 'ignored' },
          } as const;
        })(),
      );

      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });
      await consumed;
      await session.cancelPendingPrompt();
      releaseStream();

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
      expect(
        mockLlmClient.discardManagedAutoMemoryRecallDelivery,
      ).not.toHaveBeenCalled();
    });

    it('resets managed-memory delivery state after stream compression', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            type: core.StreamEventType.COMPRESSED,
            info: {
              originalTokenCount: 1000,
              newTokenCount: 200,
              compressionStatus: core.CompressionStatus.COMPRESSED,
            },
          } as const;
          yield {
            type: core.StreamEventType.CHUNK,
            value: { text: 'ok' },
          } as const;
        })(),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(
        mockLlmClient.resetManagedAutoMemoryAfterCompression,
      ).toHaveBeenCalledTimes(2);
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
    });

    it('discards delivery when the provider send fails', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockRejectedValueOnce(new Error('provider failed'));

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        }),
      ).rejects.toThrow('provider failed');

      expect(
        mockLlmClient.discardManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).not.toHaveBeenCalled();
    });

    it('discards delivery when the provider stream ends without a chunk', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield { type: core.StreamEventType.RETRY } as const;
        })(),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(
        mockLlmClient.discardManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).not.toHaveBeenCalled();
    });

    it('discards chunks from an attempt superseded by a retry', async () => {
      const delivery = {
        prompt: '<system-reminder>tree</system-reminder>',
        selectedDocs: [],
        strategy: 'heuristic',
        deliveredTreeRevision: 'tree-v1',
      };
      mockLlmClient.consumeManagedAutoMemoryRecall.mockResolvedValueOnce(
        delivery,
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: { text: 'discarded attempt' },
          } as const;
          yield { type: core.StreamEventType.RETRY } as const;
        })(),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(
        mockLlmClient.discardManagedAutoMemoryRecallDelivery,
      ).toHaveBeenCalledWith(delivery);
      expect(
        mockLlmClient.commitManagedAutoMemoryRecallDelivery,
      ).not.toHaveBeenCalled();
    });
  });

  it('rejects writer loss before mutating an existing ACP turn', async () => {
    const activePrompt = new AbortController();
    const abort = vi.spyOn(activePrompt, 'abort');
    (
      session as unknown as { pendingPrompt: AbortController | null }
    ).pendingPrompt = activePrompt;
    vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValueOnce(
      new core.SessionWriterLostError(),
    );

    await expect(
      session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toMatchObject({
      code: -32021,
      data: { errorKind: 'session_writer_lost' },
    });
    expect(abort).not.toHaveBeenCalled();
    expect(mockChatRecordingService.recordUserMessage).not.toHaveBeenCalled();
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('does not let a textual recovery command bypass writer admission', async () => {
    vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValueOnce(
      new core.SessionWriterLostError(),
    );

    await expect(
      session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '/resume missing-session' }],
      }),
    ).rejects.toMatchObject({
      code: -32021,
      data: { errorKind: 'session_writer_lost' },
    });
    expect(nonInteractiveCliCommands.handleSlashCommand).not.toHaveBeenCalled();
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('clears active todo context when an ordinary prompt starts', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start different work' }],
    });

    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenCalledWith(
      'test-session-id########1',
      undefined,
    );

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start different work' }],
      retry: true,
    } as PromptRequest);

    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenCalledWith(
      'test-session-id########2',
      'test-session-id########1',
    );
  });

  it('continues the todo work chain on an ordinary prompt while a reminder is registered', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());
    // A registered reminder means the plan still has unfinished items
    // (todo_write deletes it on completion).
    const reminder =
      '<system-reminder>unfinished todo: delegated node</system-reminder>';
    vi.mocked(mockConfig.getActiveTodoReminder).mockReturnValue(reminder);
    // The reminder comes back only when the caller forces it, so the absence
    // assertion below is what discriminates the turn-start gate.
    vi.mocked(mockConfig.takeActiveTodoReminder).mockImplementation(
      (_promptId, force = false) => (force ? reminder : undefined),
    );
    // The foreground head still owns the session plan file, so the
    // continuation guard's owner-equality conjunct holds.
    vi.mocked(mockConfig.getActiveTodoPlanWriterOwner).mockReturnValue(
      'test-session-id########1',
    );

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
    });

    // The first prompt has no previous chain to continue.
    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenCalledWith(
      'test-session-id########1',
      undefined,
    );

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'how is progress going?' }],
    });

    // The follow-up turn must continue the previous chain instead of
    // discarding the plan context it asks about (#10953).
    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
      'test-session-id########2',
      'test-session-id########1',
    );

    // Carrying the chain must not splice the plan ahead of the user's own
    // text: turn-start injection stays reserved for machine continuations
    // (core parity), and the follow-up turn is an ordinary prompt.
    const followUpCall = vi
      .mocked(mockChat.sendMessageStream)
      .mock.calls.at(-1)?.[1] as { message: Part[] };
    expect(textParts(followUpCall.message)).not.toContain(reminder);

    // Once the plan completes (todo_write deleted the reminder), the next
    // ordinary prompt must start a fresh chain — the cleared-reminder branch
    // of the continuation guard must not keep carrying the previous chain.
    vi.mocked(mockConfig.getActiveTodoReminder).mockReturnValue(undefined);
    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start different work' }],
    });
    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
      'test-session-id########3',
      undefined,
    );
  });

  it('does not continue the todo work chain when the plan was last written by a foreign owner', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());
    // A reminder is registered, but an isolated cron/notification turn last
    // wrote the session plan under its own owner — the foreground head no
    // longer owns the authoritative plan, so the continuation guard must
    // not carry (and must not re-deliver the stale foreground snapshot).
    vi.mocked(mockConfig.getActiveTodoReminder).mockReturnValue(
      '<system-reminder>unfinished todo: delegated node</system-reminder>',
    );
    vi.mocked(mockConfig.getActiveTodoPlanWriterOwner).mockReturnValue(
      'prompt-cron',
    );

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
    });

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'how is progress going?' }],
    });

    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
      'test-session-id########2',
      undefined,
    );
  });

  it.each([
    ['agent', 'success'],
    ['task', 'success'],
    [core.ToolNames.TOOL_CALL, 'success'],
    [core.ToolNames.TOOL_CALL, 'cancelled'],
    [core.ToolNames.TOOL_CALL, 'pre_execution_cancelled'],
    [core.ToolNames.TOOL_CALL, 'validation_error'],
  ] as const)(
    'accounts for delegated work when a %s tool result returns (%s)',
    async (agentToolName, outcome) => {
      const notStarted =
        outcome === 'validation_error' || outcome === 'pre_execution_cancelled';
      const reminder =
        '<system-reminder>unfinished todo: follow up on the delegated node</system-reminder>';
      // Mimic the real budget: nothing is due under the ordinary cadence
      // (the delegation consumed the only tool turn), only forcing delivers.
      vi.mocked(mockConfig.takeActiveTodoReminder).mockImplementation(
        (_promptId: string, force = false) => (force ? reminder : undefined),
      );
      const cancellation = new AbortController();
      const execute = vi.fn().mockImplementation(async () => {
        if (outcome === 'cancelled') cancellation.abort();
        return { llmContent: 'agent done', returnDisplay: 'agent done' };
      });
      const agentTool = {
        name:
          agentToolName === core.ToolNames.TOOL_CALL
            ? core.ToolNames.AGENT
            : agentToolName,
        kind: core.Kind.Execute,
        displayName: 'Agent',
        description: 'Delegates work to a subagent',
        // The schema-review gate fingerprints name + parametersJsonSchema.
        schema: {
          name: 'Agent',
          parametersJsonSchema: { type: 'object', properties: {} },
        },
        build: vi.fn().mockReturnValue({
          params: {},
          execute,
          getDefaultPermission: vi.fn().mockImplementation(async () => {
            if (outcome === 'pre_execution_cancelled') cancellation.abort();
            return 'allow';
          }),
          getDescription: vi.fn().mockReturnValue('Agent'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
        canUpdateOutput: false,
        isOutputMarkdown: true,
      };
      if (outcome === 'validation_error') {
        agentTool.build.mockImplementation(() => {
          throw new Error('invalid delegation arguments');
        });
      }
      mockToolRegistry.getTool.mockReturnValue(agentTool);
      if (agentToolName === core.ToolNames.TOOL_CALL) {
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
        mockToolRegistry.ensureTool.mockImplementation(async (name: string) =>
          findTool(name),
        );
        mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
        // The production registry always defines the schema-review gate;
        // wire it so this arm exercises the gate instead of resolving
        // unconditionally — the recorded review matches the live tool.
        mockToolRegistry.getReviewedDeclaration = vi.fn((name: string) => {
          const tool = findTool(name);
          return tool && 'build' in tool
            ? core.deferredDeclarationFingerprint(tool as never)
            : undefined;
        });
      }
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-agent-1',
                    name: agentToolName,
                    args:
                      agentToolName === core.ToolNames.TOOL_CALL
                        ? { name: core.ToolNames.AGENT, arguments: {} }
                        : {},
                  },
                ],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(createEmptyStream());

      if (outcome !== 'success') {
        const internals = session as unknown as {
          runToolCalls: Session['runToolCalls'];
        };
        const produced = await internals.runToolCalls(
          cancellation.signal,
          'producer-prompt',
          [
            {
              id: 'call-agent-1',
              name: agentToolName,
              args: { name: core.ToolNames.AGENT, arguments: {} },
            },
          ],
        );
        const {
          DEFERRED_TOOL_CALL_REFUSAL_PREFIX,
          DEFERRED_TOOL_CALL_CANCELLATION_PREFIX,
        } = await import('@qwen-code/qwen-code-core/tools/tool-call.js');
        const error = (
          produced.parts[0]?.functionResponse?.response as
            | { error?: string }
            | undefined
        )?.error;
        expect(error).toEqual(expect.any(String));
        expect(produced.repeatedToolFailureBatch?.observations).toEqual([
          expect.objectContaining({
            policyToolName: core.ToolNames.AGENT,
            executionStatus: notStarted ? 'not_started' : 'cancelled',
          }),
        ]);
        if (outcome === 'validation_error') {
          expect(error).toBe(
            `${DEFERRED_TOOL_CALL_REFUSAL_PREFIX}Deferred tool "${core.ToolNames.AGENT}" (called through tool_call) rejected the arguments: invalid delegation arguments. Pass arguments matching the schema returned by tool_search for "${core.ToolNames.AGENT}".`,
          );
        } else if (outcome === 'pre_execution_cancelled') {
          expect(
            error?.startsWith(DEFERRED_TOOL_CALL_CANCELLATION_PREFIX),
          ).toBe(true);
        } else {
          expect(
            error?.startsWith(DEFERRED_TOOL_CALL_CANCELLATION_PREFIX),
          ).toBe(false);
        }
        // Feed the actual producer result through a fresh, un-aborted turn:
        // parent cancellation otherwise ends the turn before this consumer.
        vi.spyOn(internals, 'runToolCalls').mockResolvedValueOnce(produced);
      }

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'delegate the work' }],
      });

      expect(execute).toHaveBeenCalledTimes(notStarted ? 0 : 1);
      if (notStarted) {
        expect(mockConfig.takeActiveTodoReminder).not.toHaveBeenCalledWith(
          'test-session-id########1',
          true,
        );
      } else {
        expect(mockConfig.takeActiveTodoReminder).toHaveBeenCalledWith(
          'test-session-id########1',
          true,
        );
      }
      const toolResultCall = vi
        .mocked(mockChat.sendMessageStream)
        .mock.calls.at(-1)?.[1] as { message: Part[] };
      if (notStarted) {
        expect(textParts(toolResultCall.message)).not.toContain(reminder);
      } else {
        expect(textParts(toolResultCall.message)).toContain(reminder);
      }
    },
  );

  it('includes active Todo context on the first retry request', async () => {
    const reminder =
      '<system-reminder>unfinished todo: run tests</system-reminder>';
    // Return the reminder only when the caller forces it, so this case proves
    // the retry turn's turn-start force rather than the mock's blanket value.
    vi.mocked(mockConfig.takeActiveTodoReminder).mockImplementation(
      (_promptId, force = false) => (force ? reminder : undefined),
    );
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
    });
    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
      retry: true,
    } as PromptRequest);

    const retryCall = vi
      .mocked(mockChat.sendMessageStream)
      .mock.calls.at(-1)?.[1] as {
      message: Part[];
    };
    expect(textParts(retryCall.message)).toContain(reminder);
  });

  it('continues active Todo context for related automatic turns', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());
    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
    });
    vi.mocked(mockConfig.startAutomaticActiveTodoWorkChain).mockClear();
    const reminder =
      '<system-reminder>unfinished todo: wait for agent</system-reminder>';
    vi.mocked(mockConfig.takeActiveTodoReminder).mockReturnValue(reminder);
    const internals = session as unknown as {
      relatedAgentIds: Set<string>;
    };
    internals.relatedAgentIds.add('related-agent');
    const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
      .calls[0][0] as (
      displayText: string,
      modelText: string,
      meta: {
        agentId: string;
        status: string;
        todoWorkChainId?: string;
      },
    ) => void;

    callback('Background task completed.', '<task-notification/>', {
      agentId: 'related-agent',
      status: 'completed',
      todoWorkChainId: 'test-session-id########1',
    });

    await vi.waitFor(() =>
      expect(mockConfig.startAutomaticActiveTodoWorkChain).toHaveBeenCalledWith(
        expect.stringContaining('########notification'),
        'test-session-id########1',
      ),
    );
    await vi.waitFor(() =>
      expect(mockConfig.endAutomaticActiveTodoWorkChain).toHaveBeenCalledWith(
        expect.stringContaining('########notification'),
      ),
    );
    const notificationCall = vi
      .mocked(mockChat.sendMessageStream)
      .mock.calls.at(-1)?.[1] as { message: Part[] };
    expect(textParts(notificationCall.message)).toContain(reminder);
  });

  it('delivers background workflow completions through the session queue', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());
    const callback = mockWorkflowRunRegistry.setCompletionCallback.mock
      .calls[0][0] as (
      displayText: string,
      modelText: string,
      meta: {
        runId: string;
        status: 'completed' | 'failed';
        todoWorkChainId?: string;
      },
    ) => void;

    callback('Workflow completed.', '<task-notification/>', {
      runId: 'wf_1234abcd',
      status: 'completed',
    });

    await vi.waitFor(() =>
      expect(mockChatRecordingService.recordNotification).toHaveBeenCalledWith(
        [{ text: '<task-notification/>' }],
        'Workflow completed.',
        expect.objectContaining({
          taskId: 'wf_1234abcd',
          status: 'completed',
          kind: 'workflow',
        }),
      ),
    );
  });

  it('adds terminal workflow status changes to the session history cache', () => {
    const callback = mockWorkflowRunRegistry.setStatusChangeCallback.mock
      .calls[0][0] as (entry: core.WorkflowTask) => void;
    callback({
      id: 'wf_saved',
      kind: 'workflow',
      runId: 'wf_saved',
      description: 'Review and fix',
      meta: { name: 'review-and-fix', description: 'Review and fix' },
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: ['Inspect'],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 1,
      agentsCompleted: 1,
      recentLogs: [],
      events: [],
      tokensSpent: 500,
      tokenBudgetTotal: 2_000,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    });

    expect(session.getWorkflowHistory()).toEqual([
      expect.objectContaining({
        runId: 'wf_saved',
        description: 'Review and fix',
        status: 'completed',
      }),
    ]);
  });

  it('keeps cached terminal workflow history when its disk write is missing', async () => {
    const callback = mockWorkflowRunRegistry.setStatusChangeCallback.mock
      .calls[0][0] as (entry: core.WorkflowTask) => void;
    callback({
      id: 'wf-unpersisted',
      kind: 'workflow',
      runId: 'wf-unpersisted',
      description: 'Unpersisted run',
      meta: null,
      status: 'completed',
      startTime: 1_000,
      endTime: 2_000,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [],
      events: [],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    });
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([]);

    await session.refreshWorkflowHistory();

    expect(session.getWorkflowHistory()).toEqual([
      expect.objectContaining({ runId: 'wf-unpersisted' }),
    ]);
  });

  it('does not republish a run deleted while a refresh was still reading the disk', async () => {
    // Refresh reads the directory and then merges without a claim, while
    // deletion holds one: a delete that lands between the read and the
    // merge was overwritten by the stale listing, and the run came back
    // until the next refresh.
    session.dispose();
    const snapshot = {
      runId: 'wf_stale',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    session = new Session(
      'racing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    let finishStaleRead!: (snapshots: Array<typeof snapshot>) => void;
    listWorkflowSnapshotsSpy.mockImplementationOnce(
      () =>
        new Promise<Array<typeof snapshot>>((resolve) => {
          finishStaleRead = resolve;
        }),
    );
    const staleRefresh = session.refreshWorkflowHistory();
    await vi.waitFor(() => expect(finishStaleRead).toBeDefined());

    // The delete's own refresh sees the file, then removes it.
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
    await expect(session.deleteWorkflowHistory(snapshot.runId)).resolves.toBe(
      true,
    );
    expect(session.getWorkflowHistory()).toEqual([]);

    // The read that began before the delete now completes with the
    // pre-delete listing.
    finishStaleRead([snapshot]);
    await staleRefresh;

    expect(session.getWorkflowHistory()).toEqual([]);

    // A later refresh that genuinely finds the run again (a retry reuses
    // the runId) must not be suppressed by the old deletion.
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
    await session.refreshWorkflowHistory();
    expect(session.getWorkflowHistory()).toEqual([
      expect.objectContaining({ runId: 'wf_stale' }),
    ]);
  });

  it('does not republish a run a sibling session deleted while this refresh was still reading the disk', async () => {
    // The deletion-sequence marker is per-Session, but the store and the
    // delete entrance are process-wide: session A's delete landing while
    // session B's refresh had already read the directory left nothing in
    // B to filter the stale listing, and B republished the run A's
    // client was just told was gone. The delete handler now marks the
    // deletion in every sibling, under its claim.
    session.dispose();
    const snapshot = {
      runId: 'wf_cross',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    const deleting = new Session(
      'deleting-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    session = new Session(
      'observing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    try {
      let finishStaleRead!: (snapshots: Array<typeof snapshot>) => void;
      listWorkflowSnapshotsSpy.mockImplementationOnce(
        () =>
          new Promise<Array<typeof snapshot>>((resolve) => {
            finishStaleRead = resolve;
          }),
      );
      const staleRefresh = session.refreshWorkflowHistory();
      await vi.waitFor(() => expect(finishStaleRead).toBeDefined());

      // The deleting session's own refresh sees the file, then removes
      // it, and the handler propagates the deletion to the observer.
      listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
      await expect(
        deleting.deleteWorkflowHistory(snapshot.runId),
      ).resolves.toBe(true);
      session.noteExternalWorkflowDeletion(snapshot.runId);
      expect(session.getWorkflowHistory()).toEqual([]);

      // The observer's read that began before the delete now completes
      // with the pre-delete listing.
      finishStaleRead([snapshot]);
      await staleRefresh;

      expect(session.getWorkflowHistory()).toEqual([]);

      // A later refresh that genuinely finds the run again (a retry
      // reuses the runId) is not suppressed by the old deletion.
      listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
      await session.refreshWorkflowHistory();
      expect(session.getWorkflowHistory()).toEqual([
        expect.objectContaining({ runId: 'wf_cross' }),
      ]);
    } finally {
      deleting.dispose();
    }
  });

  it('drops persisted workflow history deleted by another session', async () => {
    session.dispose();
    const snapshot = {
      runId: 'wf_abcd',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    const deletingSession = new Session(
      'deleting-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    session = new Session(
      'observing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);

    await expect(
      deletingSession.deleteWorkflowHistory(snapshot.runId),
    ).resolves.toBe(true);
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([]);

    await session.refreshWorkflowHistory();

    expect(session.getWorkflowHistory()).toEqual([]);
  });

  it('lets a newer persisted snapshot win over a stale cached one', async () => {
    const callback = mockWorkflowRunRegistry.setStatusChangeCallback.mock
      .calls[0][0] as (entry: core.WorkflowTask) => void;
    callback({
      id: 'wf_reused',
      kind: 'workflow',
      runId: 'wf_reused',
      description: 'Stale cached run',
      meta: null,
      status: 'failed',
      startTime: 1_000,
      endTime: 2_000,
      error: 'old error',
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [],
      events: [],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    });
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([
      {
        runId: 'wf_reused',
        meta: null,
        status: 'completed' as const,
        script: 'return 1;',
        phases: [],
        agentsDispatched: 0,
        agentsCompleted: 0,
        tokensSpent: 0,
        tokenBudgetTotal: null,
        perPhaseTokens: [],
        recentLogs: [],
        startTime: 3_000,
        endTime: 4_000,
      },
    ]);

    await session.refreshWorkflowHistory();

    // The persisted copy is the newer authoritative projection of the
    // reused runId; the stale callback cache must not shadow it.
    expect(session.getWorkflowHistory()).toEqual([
      expect.objectContaining({
        runId: 'wf_reused',
        status: 'completed',
        startTime: 3_000,
        endTime: 4_000,
      }),
    ]);
  });

  it('does not resurrect a sibling-deleted run cached through the status callback', async () => {
    session.dispose();
    const snapshot = {
      runId: 'wf_abcd',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    const deletingSession = new Session(
      'deleting-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    const observingSession = new Session(
      'observing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    // The observing session caches the terminal run through the
    // status-change callback, exactly as it lands before the runner's
    // snapshot write.
    const callback =
      mockWorkflowRunRegistry.setStatusChangeCallback.mock.calls.at(
        -1,
      )?.[0] as (entry: core.WorkflowTask) => void;
    callback({
      id: 'wf_abcd',
      kind: 'workflow',
      runId: 'wf_abcd',
      description: 'Callback-cached run',
      meta: null,
      status: 'failed',
      startTime: 1_000,
      endTime: 2_000,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [],
      events: [],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    });
    expect(observingSession.getWorkflowHistory()).toEqual([
      expect.objectContaining({ runId: 'wf_abcd' }),
    ]);
    // The runner then persists the snapshot; the registry notification
    // retires the observing session's unpersisted cache entry.
    const snapshotPersisted =
      mockWorkflowRunRegistry.setSnapshotPersistedCallback.mock.calls.at(
        -1,
      )?.[0] as ((runId: string) => void) | undefined;
    snapshotPersisted?.('wf_abcd');

    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
    await expect(
      deletingSession.deleteWorkflowHistory(snapshot.runId),
    ).resolves.toBe(true);
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([]);

    await observingSession.refreshWorkflowHistory();

    expect(observingSession.getWorkflowHistory()).toEqual([]);
  });

  it('keeps a sibling-deleted run buried when a late status emission lands after persistence', async () => {
    // R7-5: the existing non-resurrection test fires the status callback
    // only BEFORE snapshotPersisted, so it cannot see the real ordering.
    // The registry's dispatch-drain callbacks emit on TERMINAL entries
    // with no status gate, and in-flight dispatches keep draining across
    // the snapshot write — so a terminal emission routinely lands AFTER
    // retirement, re-inserting the run as "never persisted". A sibling's
    // deletion was then undone by the next refresh: absent on disk but
    // present in the stale cache reads as a pending write. Retirement has
    // to be a latch.
    session.dispose();
    const snapshot = {
      runId: 'wf_abcd',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    const deletingSession = new Session(
      'deleting-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    const observingSession = new Session(
      'observing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    const terminalEntry = {
      id: 'wf_abcd',
      kind: 'workflow' as const,
      runId: 'wf_abcd',
      description: 'Callback-cached run',
      meta: null,
      status: 'failed' as const,
      startTime: 1_000,
      endTime: 2_000,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [],
      events: [],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    };
    const callback =
      mockWorkflowRunRegistry.setStatusChangeCallback.mock.calls.at(
        -1,
      )?.[0] as (entry: core.WorkflowTask) => void;
    const snapshotPersisted =
      mockWorkflowRunRegistry.setSnapshotPersistedCallback.mock.calls.at(
        -1,
      )?.[0] as ((runId: string) => void) | undefined;

    callback(terminalEntry);
    snapshotPersisted?.('wf_abcd');
    // A draining dispatch emits once more on the already-terminal entry,
    // after retirement. This is the ordering the bug lived in.
    callback(terminalEntry);

    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
    await expect(
      deletingSession.deleteWorkflowHistory(snapshot.runId),
    ).resolves.toBe(true);
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([]);

    await observingSession.refreshWorkflowHistory();
    expect(observingSession.getWorkflowHistory()).toEqual([]);
  });

  it('re-remembers a run whose id is registered again after persistence', async () => {
    // The latch must not be permanent: a retry reuses the runId, so once
    // the entry goes active again its next settlement has to be cached
    // like any other, or a genuine re-run would vanish from the session's
    // projection until its own snapshot write lands.
    session.dispose();
    const observingSession = new Session(
      'observing-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    const base = {
      id: 'wf_relive',
      kind: 'workflow' as const,
      runId: 'wf_relive',
      description: 'Re-run',
      meta: null,
      startTime: 1_000,
      outputFile: '',
      outputOffset: 0,
      notified: true,
      abortController: new AbortController(),
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      recentLogs: [],
      events: [],
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: new Map(),
      pendingApprovals: [],
      script: 'return 1;',
    };
    const callback =
      mockWorkflowRunRegistry.setStatusChangeCallback.mock.calls.at(
        -1,
      )?.[0] as (entry: core.WorkflowTask) => void;
    const snapshotPersisted =
      mockWorkflowRunRegistry.setSnapshotPersistedCallback.mock.calls.at(
        -1,
      )?.[0] as ((runId: string) => void) | undefined;

    callback({
      ...base,
      status: 'failed',
      endTime: 2_000,
    } as core.WorkflowTask);
    snapshotPersisted?.('wf_relive');
    // The retry re-registers the same runId and runs.
    callback({
      ...base,
      status: 'running',
      endTime: undefined,
    } as core.WorkflowTask);
    // Its own settlement must be cached again.
    callback({
      ...base,
      status: 'completed',
      endTime: 3_000,
    } as core.WorkflowTask);

    expect(observingSession.getWorkflowHistory()).toEqual([
      expect.objectContaining({ runId: 'wf_relive', status: 'completed' }),
    ]);
  });

  it('deletes a run that fell out of the capped history window', async () => {
    // R7-4: `buildSessionTasksStatus` serializes every registry entry
    // unconditionally, but deletion gated on membership in the
    // MAX_RETAINED_SNAPSHOTS window, which `refreshWorkflowHistory`
    // truncates by startTime. A long run that settles after ~30 newer
    // ones started stayed listed via the registry yet fell out of the
    // window — terminal, handle-free, live in no sibling, and permanently
    // undeletable. Membership must be tested against the uncapped set.
    session.dispose();
    const target = {
      runId: 'wf_oldest',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    // 30 strictly newer snapshots fill the window ahead of the target.
    const newer = Array.from(
      { length: core.MAX_RETAINED_SNAPSHOTS },
      (_, i) => ({
        ...target,
        runId: `wf_newer${i}`,
        startTime: 10_000 + i,
        endTime: 20_000 + i,
      }),
    );
    const deletingSession = new Session(
      'deleting-session',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [],
    );
    mockWorkflowRunRegistry.get.mockReturnValue({
      runId: target.runId,
      status: 'failed',
    });
    mockWorkflowRunRegistry.removeTerminal.mockReturnValueOnce(true);
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([...newer, target]);

    await expect(
      deletingSession.deleteWorkflowHistory(target.runId),
    ).resolves.toBe(true);
    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledWith(
      mockConfig,
      target.runId,
    );
    expect(mockWorkflowRunRegistry.removeTerminal).toHaveBeenCalledWith(
      target.runId,
    );
  });

  it('rejects history deletion while a sibling session still owns the run', async () => {
    session.dispose();
    const snapshot = {
      runId: 'wf_deadbeef',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    const siblingRegistry = {
      get: vi.fn().mockReturnValue({ runId: 'wf_deadbeef', status: 'running' }),
      getHandle: vi.fn().mockReturnValue(undefined),
    };
    const isWorkflowRunLiveInSiblingSession = (runId: string): boolean => {
      const entry = siblingRegistry.get(runId) as
        | { status: core.WorkflowStatus }
        | undefined;
      if (entry && !core.isTerminalWorkflowStatus(entry.status)) return true;
      return siblingRegistry.getHandle(runId) !== undefined;
    };
    listWorkflowSnapshotsSpy.mockResolvedValue([snapshot]);
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
      isWorkflowRunLiveInSiblingSession,
    );

    await expect(session.deleteWorkflowHistory(snapshot.runId)).resolves.toBe(
      false,
    );
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();

    // Once the sibling run settles terminal, deletion proceeds.
    siblingRegistry.get.mockReturnValue({
      runId: 'wf_deadbeef',
      status: 'failed',
    });
    await expect(session.deleteWorkflowHistory(snapshot.runId)).resolves.toBe(
      true,
    );
    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledWith(
      mockConfig,
      snapshot.runId,
    );
  });

  it('does not report a deletion whose registry entry could not be retired', async () => {
    // `removeTerminal` refuses a live or handle-held entry. Ignoring its
    // answer reported success for a run that was still registered here,
    // whose settlement then re-persisted the "deleted" history.
    session.dispose();
    const snapshot = {
      runId: 'wf_stuck',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );
    listWorkflowSnapshotsSpy.mockResolvedValue([snapshot]);
    mockWorkflowRunRegistry.get.mockReturnValue({
      runId: snapshot.runId,
      status: 'failed',
    });
    mockWorkflowRunRegistry.removeTerminal.mockReturnValueOnce(false);

    await expect(session.deleteWorkflowHistory(snapshot.runId)).resolves.toBe(
      false,
    );
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();
    expect(session.getWorkflowHistory()).toHaveLength(1);

    mockWorkflowRunRegistry.removeTerminal.mockReturnValueOnce(true);
    await expect(session.deleteWorkflowHistory(snapshot.runId)).resolves.toBe(
      true,
    );
    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledWith(
      mockConfig,
      snapshot.runId,
    );
  });

  it('keeps cached history on disk failure and removes it after deletion', async () => {
    session.dispose();
    const onActiveWorkChanged = vi.fn();
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      onActiveWorkChanged,
      [
        {
          runId: 'wf_abcd',
          meta: { name: 'review-and-fix', description: 'Review and fix' },
          status: 'failed',
          script: 'return 1;',
          phases: ['Inspect'],
          agentsDispatched: 1,
          agentsCompleted: 0,
          tokensSpent: 500,
          tokenBudgetTotal: 2_000,
          perPhaseTokens: [],
          recentLogs: [],
          startTime: 1_000,
          endTime: 2_000,
        },
      ],
    );
    listWorkflowSnapshotsSpy.mockResolvedValue(session.getWorkflowHistory());

    deleteWorkflowSnapshotSpy.mockResolvedValueOnce(false);
    await expect(session.deleteWorkflowHistory('wf_abcd')).resolves.toBe(false);
    expect(session.getWorkflowHistory()).toHaveLength(1);
    expect(onActiveWorkChanged).not.toHaveBeenCalled();

    await expect(session.deleteWorkflowHistory('wf_abcd')).resolves.toBe(true);

    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledWith(
      mockConfig,
      'wf_abcd',
    );
    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledTimes(2);
    expect(session.getWorkflowHistory()).toEqual([]);
    expect(onActiveWorkChanged).toHaveBeenCalledOnce();
  });

  it('keeps history unchanged when the requested saved run is unknown', async () => {
    await expect(session.deleteWorkflowHistory('wf_missing')).resolves.toBe(
      false,
    );

    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();
  });

  it('waits for an active run owner to finish persistence before deletion', async () => {
    session.dispose();
    const snapshot = {
      runId: 'wf_pending',
      meta: null,
      status: 'completed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    let finishPersistence: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    mockWorkflowRunRegistry.getHandle.mockReturnValue({ completion });
    listWorkflowSnapshotsSpy.mockResolvedValue([snapshot]);
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
      undefined,
      undefined,
      [snapshot],
    );

    const deletion = session.deleteWorkflowHistory(snapshot.runId);
    await Promise.resolve();
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();

    finishPersistence?.();
    await expect(deletion).resolves.toBe(true);
    expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledWith(
      mockConfig,
      snapshot.runId,
    );
  });

  it('stops deletion when a retry activates the run during refresh', async () => {
    const snapshot = {
      runId: 'wf_abcd',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    let finishRefresh!: () => void;
    listWorkflowSnapshotsSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => resolve([snapshot]);
        }),
    );
    mockWorkflowRunRegistry.get.mockReturnValue({ status: 'failed' });

    const deletion = session.deleteWorkflowHistory(snapshot.runId);
    await vi.waitFor(() =>
      expect(listWorkflowSnapshotsSpy).toHaveBeenCalledOnce(),
    );
    mockWorkflowRunRegistry.get.mockReturnValue({ status: 'running' });
    finishRefresh();

    await expect(deletion).resolves.toBe(false);
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();
  });

  it('keeps deletion atomic with a direct workflow resume', async () => {
    const snapshot = {
      runId: 'wf_atomic',
      meta: null,
      status: 'failed' as const,
      script: 'return 1;',
      phases: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      perPhaseTokens: [],
      recentLogs: [],
      startTime: 1_000,
      endTime: 2_000,
    };
    let finishDeletion: ((deleted: boolean) => void) | undefined;
    deleteWorkflowSnapshotSpy.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishDeletion = resolve;
        }),
    );
    listWorkflowSnapshotsSpy.mockResolvedValueOnce([snapshot]);
    mockWorkflowRunRegistry.get.mockReturnValue({ status: 'failed' });
    mockWorkflowRunRegistry.removeTerminal.mockReturnValueOnce(true);

    const deletion = session.deleteWorkflowHistory(snapshot.runId);
    await vi.waitFor(() =>
      expect(deleteWorkflowSnapshotSpy).toHaveBeenCalledOnce(),
    );

    const resumeAttempt = await core.tryWithWorkflowTaskMutation(
      core.getWorkflowTaskMutationKey(mockConfig, snapshot.runId),
      async () => true,
    );
    expect(resumeAttempt).toEqual({ acquired: false });

    finishDeletion?.(true);
    await expect(deletion).resolves.toBe(true);
  });

  it('rejects history deletion while the workflow is starting', async () => {
    mockWorkflowRunRegistry.get.mockReturnValue({ status: 'failed' });
    mockWorkflowRunRegistry.isStarting.mockReturnValue(true);

    await expect(session.deleteWorkflowHistory('wf_starting')).resolves.toBe(
      false,
    );

    expect(listWorkflowSnapshotsSpy).not.toHaveBeenCalled();
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();
  });

  it('rejects history deletion while the workflow is active', async () => {
    mockWorkflowRunRegistry.get.mockReturnValue({ status: 'paused' });

    await expect(session.deleteWorkflowHistory('wf_active')).resolves.toBe(
      false,
    );

    expect(mockWorkflowRunRegistry.getHandle).not.toHaveBeenCalled();
    expect(listWorkflowSnapshotsSpy).not.toHaveBeenCalled();
    expect(deleteWorkflowSnapshotSpy).not.toHaveBeenCalled();
  });

  it('does not infer Todo ownership from Todo Stop Guard lineage', async () => {
    mockChat.sendMessageStream = vi
      .fn()
      .mockImplementation(async () => createEmptyStream());
    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
    });
    vi.mocked(mockConfig.startAutomaticActiveTodoWorkChain).mockClear();
    const internals = session as unknown as {
      relatedAgentIds: Set<string>;
    };
    internals.relatedAgentIds.add('guard-related-agent');
    const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
      .calls[0][0] as (
      displayText: string,
      modelText: string,
      meta: { agentId: string; status: string },
    ) => void;

    callback('Background task completed.', '<task-notification/>', {
      agentId: 'guard-related-agent',
      status: 'completed',
    });

    await vi.waitFor(() =>
      expect(mockConfig.startAutomaticActiveTodoWorkChain).toHaveBeenCalledWith(
        expect.stringContaining('########notification'),
        undefined,
      ),
    );

    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'start work' }],
      retry: true,
    } as PromptRequest);
    expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
      'test-session-id########2',
      'test-session-id########1',
    );
  });

  it('holds the close gate until active turns settle', async () => {
    let resolveTurn!: () => void;
    const turnCompletion = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    (
      session as unknown as {
        pendingPromptCompletion: Promise<void> | null;
      }
    ).pendingPromptCompletion = turnCompletion;

    const releaseClose = session.beginClose();
    await expect(
      session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    const notificationCallback =
      mockBackgroundTaskRegistry.setNotificationCallback.mock.calls.at(
        -1,
      )?.[0] as (
        displayText: string,
        modelText: string,
        meta: { agentId: string; status: string },
      ) => void;
    notificationCallback('background done', '<background-done />', {
      agentId: 'close-gated-agent',
      status: 'completed',
    });
    await Promise.resolve();
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    const internals = session as unknown as {
      notificationQueue: Array<{ taskId: string }>;
    };
    expect(internals.notificationQueue).toEqual([
      expect.objectContaining({ taskId: 'close-gated-agent' }),
    ]);

    let settled = false;
    const waiting = session.waitForActiveTurnsToSettle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    void turnCompletion.then(() => {
      (
        session as unknown as {
          pendingPromptCompletion: Promise<void> | null;
        }
      ).pendingPromptCompletion = null;
    });
    resolveTurn();
    await waiting;
    internals.notificationQueue = [];
    releaseClose();
  });

  it('waits for a successor prompt admitted before the close gate', async () => {
    let resolveFirst!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let resolveSecond!: () => void;
    const secondCompletion = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const internals = session as unknown as {
      pendingPrompt: AbortController | null;
      pendingPromptCompletion: Promise<void> | null;
    };
    internals.pendingPrompt = new AbortController();
    internals.pendingPromptCompletion = firstCompletion;
    void firstCompletion.then(() => {
      internals.pendingPromptCompletion = secondCompletion;
    });
    void secondCompletion.then(() => {
      internals.pendingPromptCompletion = null;
      internals.pendingPrompt = null;
    });

    const releaseClose = session.beginClose();
    let settled = false;
    const waiting = session.waitForActiveTurnsToSettle().then(() => {
      settled = true;
    });
    resolveFirst();
    await firstCompletion;
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSecond();
    await waiting;
    expect(settled).toBe(true);
    releaseClose();
  });

  it('yields to the event loop when completions are settled but flags remain', async () => {
    const internals = session as unknown as {
      notificationProcessing: boolean;
      notificationCompletion: Promise<void> | null;
    };
    internals.notificationProcessing = true;
    internals.notificationCompletion = Promise.resolve();

    // Clear the flag on a macrotask — only reachable if the loop yields
    // via setImmediate rather than spinning on microtasks.
    setImmediate(() => {
      internals.notificationProcessing = false;
      internals.notificationCompletion = null;
    });

    await session.waitForActiveTurnsToSettle();
  });

  it('polls rather than spins when the active turn publishes no completion', async () => {
    // `historyMutationActive` blocks `#hasActiveTurn()` without publishing a
    // completion promise, so the wait has nothing to await. Yielding on
    // `setImmediate` alone would cycle the event loop as fast as it can turn
    // and burn a core for the whole wait — on the conditional-close path that
    // is the full drain budget. Counting the yields is the observable proxy:
    // the polled wait makes none from this path.
    const releaseMutation = session.beginHistoryMutation();
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      let settled = false;
      const waiting = session.waitForActiveTurnsToSettle().then(() => {
        settled = true;
      });
      // The hold is still up, so the wait must still be waiting. Without this
      // a `#hasActiveTurn()` that stopped consulting `historyMutationActive`
      // would resolve at once and both yield counts below would be vacuously
      // zero — the test would pass while pinning nothing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      releaseMutation();
      await waiting;
      expect(settled).toBe(true);
      expect(immediateSpy).toHaveBeenCalledTimes(0);
      // The poll has to be a real interval, and the constant is module-local
      // so the literal has to be spelled here. A 0ms `setTimeout` still hands
      // back a macrotask, so the count above stays green while the loop
      // re-arms as fast as the event loop turns — the same spin, one level
      // down. Two re-arms is the floor: 50ms of holding at 10ms allows ~5.
      const polls = timeoutSpy.mock.calls.filter((call) => call[1] === 10);
      expect(polls.length).toBeGreaterThanOrEqual(2);
    } finally {
      immediateSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  });

  it('rejects a prompt when the close gate starts during writer admission', async () => {
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    let markAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve;
    });
    vi.mocked(mockConfig.assertCanStartTurn).mockImplementationOnce(
      async () => {
        markAdmissionStarted();
        await admission;
      },
    );

    const prompt = session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'must not cross the close gate' }],
    });
    await admissionStarted;
    const releaseClose = session.beginClose();
    resolveAdmission();

    await expect(prompt).rejects.toMatchObject({ code: -32602 });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    releaseClose();
  });

  it('rejects a prompt while an exclusive history mutation is active', async () => {
    const releaseMutation = session.beginHistoryMutation();

    expect(session.isIdle()).toBe(false);
    expect(session.isTurnIdle()).toBe(false);
    await expect(
      session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'must wait for the branch' }],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();

    releaseMutation();
    expect(session.isIdle()).toBe(true);
    expect(session.isTurnIdle()).toBe(true);
  });

  it('rejects a prompt when a history mutation begins during writer admission', async () => {
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      resolveAdmission = resolve;
    });
    let markAdmissionStarted!: () => void;
    const admissionStarted = new Promise<void>((resolve) => {
      markAdmissionStarted = resolve;
    });
    vi.mocked(mockConfig.assertCanStartTurn).mockImplementationOnce(
      async () => {
        markAdmissionStarted();
        await admission;
      },
    );

    const prompt = session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'must not race the branch' }],
    });
    await admissionStarted;
    const releaseMutation = session.beginHistoryMutation();
    resolveAdmission();

    await expect(prompt).rejects.toMatchObject({ code: -32602 });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    releaseMutation();
  });

  it('does not reopen a disposed session when a close gate releases late', async () => {
    const releaseClose = session.beginClose();
    const closeGateCompletion = session.waitForCloseGateToRelease();

    expect(session.beginCloseIfAvailable()).toBeNull();
    session.dispose();
    await expect(closeGateCompletion).resolves.toBeUndefined();
    expect(() => session.beginCloseIfAvailable()).toThrow(
      'Session has been disposed',
    );
    releaseClose();

    expect(session.isIdle()).toBe(false);
    await expect(session.assertCanStartTurn()).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('cancels an admitted call without cancelling a background turn', async () => {
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    mockConfig.assertCanStartTurn = vi.fn().mockReturnValue(admission);
    const cancellation = new AbortController();

    const prompt = session.prompt(
      {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      },
      undefined,
      cancellation.signal,
    );
    await vi.waitFor(() =>
      expect(mockConfig.assertCanStartTurn).toHaveBeenCalledOnce(),
    );
    cancellation.abort();
    releaseAdmission();

    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('pins durable cron startup, prompt restart, and stop to the session runtime', async () => {
    const runtimeDir = path.resolve('runtime', 'cron-session');
    const observedStarts: string[] = [];
    const observedStops: string[] = [];
    const scheduler = {
      hasPendingWork: false,
      enableDurable: vi.fn().mockImplementation(async () => {
        observedStarts.push(core.Storage.getRuntimeBaseDir());
      }),
      start: vi.fn(),
      stop: vi.fn().mockImplementation(() => {
        observedStops.push(core.Storage.getRuntimeBaseDir());
      }),
      list: vi.fn().mockReturnValue([]),
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    session.dispose();
    core.Storage.setRuntimeBaseDir(runtimeDir);
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    mockConfig.getWorkingDir = vi.fn().mockReturnValue('/logical-after-cd');
    mockChat.sendMessageStream = vi.fn().mockResolvedValue(createEmptyStream());
    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
    );

    session.startCronScheduler();
    await vi.waitFor(() => expect(scheduler.enableDurable).toHaveBeenCalled());
    await session.prompt({
      sessionId: 'test-session-id',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await vi.waitFor(() =>
      expect(scheduler.enableDurable).toHaveBeenCalledTimes(2),
    );
    session.dispose();

    expect(observedStarts).toEqual([runtimeDir, runtimeDir]);
    expect(observedStops).toEqual([runtimeDir]);
  });

  it('dispatches a per-run scheduled task into a fresh daemon session', async () => {
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            name: string;
            prompt: string;
            cronExpr: string;
            lastFiredAt: number;
            sessionMode: 'per_run';
            modelServiceId: string;
            groupId: string;
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            name: 'Review PRs',
            prompt: 'review the next PR',
            cronExpr: '0 * * * *',
            lastFiredAt: 123,
            sessionMode: 'per_run',
            modelServiceId: 'qwen-max(openai)',
            groupId: 'group-1',
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    vi.mocked(mockClient.extMethod).mockResolvedValueOnce({
      sessionId: 'child-session',
    });

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(mockClient.extMethod).toHaveBeenCalledWith(
        SERVE_CONTROL_EXT_METHODS.createSubSession,
        {
          prompt: expect.stringMatching(
            /^Scheduled task: Review PRs\nTask ID: task-1\nSchedule: 0 \* \* \* \*\nTriggered at: 1970-01-01T00:00:00\.123Z\nTrigger: scheduled\nSession: new chat for this run\n\nThis is a scheduled task run\. Execute the instructions below now\. Do not create or modify a schedule unless the instructions explicitly ask you to\.\n\nreview the next PR$/,
          ),
          completion: 'sent',
          name: expect.stringMatching(/^Review PRs · \d{2}-\d{2} \d{2}:\d{2}$/),
          sourceType: 'default',
          sourceId: 'scheduled_task_run:task-1',
          model: 'qwen-max(openai)',
          groupId: 'group-1',
          callerSessionId: 'test-session-id',
        },
      );
    });
    await vi.waitFor(() => {
      expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
        sessionId: 'child-session',
      });
    });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('titles a gated per-run fire’s fresh session from the task prompt, not the gate’s text', async () => {
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            taskPrompt: string;
            cronExpr: string;
            lastFiredAt: number;
            sessionMode: 'per_run';
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt:
              'Summarize new PR comments\n\nGate output. The task’s gate command printed this.',
            taskPrompt: 'Summarize new PR comments',
            cronExpr: '0 * * * *',
            lastFiredAt: 123,
            sessionMode: 'per_run',
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    vi.mocked(mockClient.extMethod).mockResolvedValueOnce({
      sessionId: 'child-session',
    });

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(mockClient.extMethod).toHaveBeenCalledWith(
        SERVE_CONTROL_EXT_METHODS.createSubSession,
        expect.objectContaining({
          prompt: expect.stringContaining('Gate output.'),
          name: expect.stringMatching(
            /^Summarize new PR comments · \d{2}-\d{2} \d{2}:\d{2}$/,
          ),
        }),
      );
    });
  });

  it('runs a per-run scheduled task in the task session when the daemon cannot create a fresh one', async () => {
    const recordOrder: string[] = [];
    mockChatRecordingService.recordSessionApprovalMode.mockImplementationOnce(
      async () => {
        recordOrder.push('approval');
        return true;
      },
    );
    mockChat.sendMessageStream = vi.fn(async () => {
      recordOrder.push('model');
      return createEmptyStream();
    });
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            cronExpr: string;
            lastFiredAt: number;
            sessionMode: 'per_run';
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt: 'review the next PR',
            cronExpr: '0 * * * *',
            lastFiredAt: 123,
            sessionMode: 'per_run',
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    vi.mocked(mockClient.extMethod).mockRejectedValueOnce(
      new Error('Method not found'),
    );

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(mockClient.extMethod).toHaveBeenCalledWith(
        SERVE_CONTROL_EXT_METHODS.createSubSession,
        // Untitled task: the child is named from the task prompt, never from
        // the execution-context header.
        expect.objectContaining({
          name: expect.stringMatching(
            /^review the next PR · \d{2}-\d{2} \d{2}:\d{2}$/,
          ),
        }),
      );
    });
    // The fire is not lost: it runs here, and the run record says so.
    await vi.waitFor(() => {
      expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
        sessionId: 'test-session-id',
        dispatchFailed: true,
      });
    });
    await vi.waitFor(() => {
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
    });
    expect(recordOrder.slice(0, 2)).toEqual(['approval', 'model']);
    expect(
      JSON.stringify(vi.mocked(mockChat.sendMessageStream).mock.calls[0]),
    ).toContain('review the next PR');
    expect(
      JSON.stringify(vi.mocked(mockChat.sendMessageStream).mock.calls[0]),
    ).not.toContain('Scheduled task:');
  });

  it('does not fall back to the task session when a routed dispatch fails', async () => {
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            cronExpr: string;
            lastFiredAt: number;
            sessionMode: 'per_run';
            groupId: string;
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt: 'review the next PR',
            cronExpr: '0 * * * *',
            lastFiredAt: 123,
            sessionMode: 'per_run',
            groupId: 'group-1',
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    vi.mocked(mockClient.extMethod).mockRejectedValueOnce(
      new Error('session capacity exhausted'),
    );

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
        dispatchFailed: true,
      });
    });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('restores a consumed one-shot when selected-model dispatch fails', async () => {
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const restoreConsumedOneShot = vi.fn().mockResolvedValue(true);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            cronExpr: string;
            recurring: false;
            lastFiredAt: number;
            sessionMode: 'per_run';
            modelServiceId: string;
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt: 'review the next PR',
            cronExpr: '0 * * * *',
            recurring: false,
            lastFiredAt: 123,
            sessionMode: 'per_run',
            modelServiceId: 'missing-model',
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      restoreConsumedOneShot,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    vi.mocked(mockClient.extMethod).mockRejectedValueOnce(
      new Error('session capacity exhausted'),
    );

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(restoreConsumedOneShot).toHaveBeenCalledWith('task-1');
    });
    expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
      dispatchFailed: true,
    });
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('does not dispatch a scheduled task with an over-long model id', async () => {
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const restoreConsumedOneShot = vi.fn().mockResolvedValue(true);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            cronExpr: string;
            recurring: false;
            lastFiredAt: number;
            sessionMode: 'per_run';
            modelServiceId: string;
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt: 'review the next PR',
            cronExpr: '0 * * * *',
            recurring: false,
            lastFiredAt: 123,
            sessionMode: 'per_run',
            modelServiceId: 'm'.repeat(MAX_CRON_TASK_ROUTING_ID_LENGTH + 1),
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      restoreConsumedOneShot,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
        dispatchFailed: true,
      });
      expect(restoreConsumedOneShot).toHaveBeenCalledWith('task-1');
    });
    expect(mockClient.extMethod).not.toHaveBeenCalled();
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
  });

  it('enqueues a missed one-shot carrier instead of dispatching it headless', async () => {
    // The scheduler synthesises a carrier for a missed one-shot whose prompt is
    // the confirm-first notification ("ask the user before running it"). It
    // inherits sessionMode from the task it stands for, so a per_run task's
    // carrier must NOT be wrapped in the execute-now header and run in a fresh
    // child with nobody attached to answer the confirmation.
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(
        (
          callback: (job: {
            id: string;
            prompt: string;
            cronExpr: string;
            lastFiredAt: number;
            sessionMode: 'per_run';
            missed: true;
          }) => void,
        ) => {
          callback({
            id: 'task-1',
            prompt:
              'Do NOT execute this prompt yet. First ask the user whether to run it now: review the next PR',
            cronExpr: '0 * * * *',
            lastFiredAt: 123,
            sessionMode: 'per_run',
            missed: true,
          });
        },
      ),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
    });
    expect(mockClient.extMethod).not.toHaveBeenCalledWith(
      SERVE_CONTROL_EXT_METHODS.createSubSession,
      expect.anything(),
    );
    const enqueued = JSON.stringify(
      vi.mocked(mockChat.sendMessageStream).mock.calls[0],
    );
    expect(enqueued).toContain('First ask the user whether to run it now');
    expect(enqueued).not.toContain('Execute the instructions below now');
  });

  it('attributes a slow per-run dispatch to the fire that started it', async () => {
    // processJob re-stamps the live jobs-map entry every matching minute. A
    // spawn round-trip that outlasts one interval must still annotate the run
    // record of the fire it was dispatched for, not the next one's.
    const annotateRunSession = vi.fn().mockResolvedValue(undefined);
    const job = {
      id: 'task-1',
      prompt: 'review the next PR',
      cronExpr: '* * * * *',
      lastFiredAt: 123,
      sessionMode: 'per_run' as const,
    };
    const scheduler = {
      hasPendingWork: true,
      enableDurable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn((callback: (fire: typeof job) => void) => {
        callback(job);
      }),
      stop: vi.fn(),
      annotateRunSession,
      getExitSummary: vi.fn().mockReturnValue(undefined),
    };
    mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
    mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
    let releaseSpawn!: () => void;
    const spawned = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    vi.mocked(mockClient.extMethod).mockImplementationOnce(async () => {
      // The next tick lands while the spawn RPC is still in flight.
      job.lastFiredAt = 456;
      await spawned;
      return { sessionId: 'child-session' };
    });

    session.startCronScheduler();

    await vi.waitFor(() => {
      expect(mockClient.extMethod).toHaveBeenCalled();
    });
    releaseSpawn();

    await vi.waitFor(() => {
      expect(annotateRunSession).toHaveBeenCalledWith('task-1', 123, {
        sessionId: 'child-session',
      });
    });
  });

  it('does not resume automatic turns until an aborted prompt settles', async () => {
    let resolvePromptCompletion!: () => void;
    const promptCompletion = new Promise<void>((resolve) => {
      resolvePromptCompletion = resolve;
    });
    (
      session as unknown as {
        pendingPromptCompletion: Promise<void> | null;
      }
    ).pendingPromptCompletion = promptCompletion;
    mockChat.sendMessageStream = vi.fn().mockResolvedValue(createEmptyStream());

    const releaseClose = session.beginClose();
    const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
      .calls[0][0] as (
      displayText: string,
      modelText: string,
      meta: { agentId: string; status: string },
    ) => void;
    callback('Background task completed.', '<task-notification/>', {
      agentId: 'agent-1',
      status: 'completed',
    });

    releaseClose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockChat.sendMessageStream).not.toHaveBeenCalled();

    resolvePromptCompletion();
    (
      session as unknown as {
        pendingPromptCompletion: Promise<void> | null;
      }
    ).pendingPromptCompletion = null;
    await vi.waitFor(() => {
      expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
    });
  });

  describe('continueLastTurn', () => {
    it('uses classifiable recovery history before the bounded pre-check', async () => {
      const getHistoryForRecovery = vi.fn(() => [
        { role: 'model', parts: [{ text: 'Done.' }] },
      ]);
      Object.assign(mockChat, { getHistoryForRecovery });
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'restored context' }] },
      ]);

      expect(session.getRecoveryStatus()).toEqual({
        kind: 'clean',
        canContinue: false,
      });
      expect(getHistoryForRecovery).toHaveBeenCalledWith(50);
    });

    it.each(['user', 'unknown', 'interrupted'] as const)(
      'checks raw transcript cancellation before admission (%s)',
      async (reason) => {
        const input: Content = {
          role: 'user',
          parts: [{ text: 'unfinished task' }],
        };
        markApiHistoryPrompt(input, 'client-turn');
        vi.mocked(mockChat.getHistory).mockReturnValue([input]);
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue([input]);
        const records = [
          chatRecord({
            uuid: 'input',
            promptId: 'client-turn',
            daemonPromptId: 'daemon-turn',
            message: input,
          }),
          chatRecord({
            uuid: 'result',
            parentUuid: 'input',
            type: 'system',
            subtype: 'turn_result',
            promptId: 'client-turn',
            systemPayload: {
              promptId: 'daemon-turn',
              state: 'cancelled',
              startedAt: 1_000,
              endedAt: 2_500,
              ...(reason !== 'interrupted' ? { cancelledAt: 2_200 } : {}),
              ...(reason === 'user' ? { cancelReason: 'user' } : {}),
            },
          }),
        ];
        mockChatRecordingService.readActiveTranscriptChain.mockResolvedValue(
          records,
        );
        const canContinue = reason === 'interrupted';
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(await session.continueLastTurn()).toEqual({
            accepted: canContinue,
            interruption: 'interrupted_prompt',
          });
          if (!canContinue) {
            await expect(
              session.prompt(
                {
                  sessionId: session.sessionId,
                  prompt: [],
                  _meta: { 'qwen.daemon.continueLastTurn': true },
                },
                {
                  version: 1,
                  sessionId: session.sessionId,
                  promptId: `refused-${attempt}`,
                },
              ),
            ).resolves.toEqual({ stopReason: 'end_turn' });
          }
        }
        const clientStatus = await session.getRecoveryStatusForClient();
        expect(clientStatus.kind).toBe('interrupted_prompt');
        expect(clientStatus.canContinue).toBe(reason !== 'user');
        expect(clientStatus.cancellationConfirmationId).toBe(
          reason === 'unknown' ? 'result' : undefined,
        );
        if (reason === 'unknown') {
          const statusWhileLoading = session.getRecoveryStatusForClient();
          const internals = session as unknown as {
            pendingPrompt: AbortController | null;
          };
          internals.pendingPrompt = new AbortController();
          try {
            await expect(statusWhileLoading).resolves.toEqual({
              kind: 'interrupted_prompt',
              canContinue: false,
            });
          } finally {
            internals.pendingPrompt = null;
          }
        }
        expect((await session.continueLastTurn('stale')).accepted).toBe(false);
        expect((await session.continueLastTurn('result')).accepted).toBe(
          reason === 'unknown',
        );
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordTurnAttempt,
        ).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordTurnResult,
        ).not.toHaveBeenCalled();
      },
    );

    it.each(['disabled', 'read-failure'] as const)(
      'keeps recovery status readable and continuation blocked when recording is %s',
      async (recording) => {
        vi.mocked(mockChat.getHistory).mockReturnValue([
          { role: 'user', parts: [{ text: 'unfinished task' }] },
        ]);
        if (recording === 'disabled') {
          vi.mocked(mockConfig.getChatRecordingService).mockReturnValue(
            undefined,
          );
        } else {
          mockChatRecordingService.readActiveTranscriptChain.mockRejectedValue(
            new Error('sticky transcript write failure'),
          );
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(session.getRecoveryStatusForClient()).resolves.toEqual({
            kind: 'interrupted_prompt',
            canContinue: false,
          });
          await expect(session.continueLastTurn()).resolves.toEqual({
            accepted: false,
            interruption: 'interrupted_prompt',
          });
        }
        await expect(
          session.prompt({
            sessionId: session.sessionId,
            prompt: [],
            _meta: { 'qwen.daemon.continueLastTurn': true },
          }),
        ).rejects.toThrow(
          recording === 'disabled'
            ? 'Recovery requires a session transcript'
            : 'sticky transcript write failure',
        );
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordTurnAttempt,
        ).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordTurnResult,
        ).not.toHaveBeenCalled();
      },
    );

    it('returns none and starts no continuation when the last turn ended cleanly', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'hi' }] },
        { role: 'model', parts: [{ text: 'all done' }] },
      ]);
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      const result = await session.continueLastTurn();

      expect(result).toEqual({ accepted: false, interruption: 'none' });
      expect(session.getRecoveryStatus()).toEqual({
        kind: 'clean',
        canContinue: false,
      });
      const classify = vi.spyOn(session, 'getRecoveryStatus');
      await expect(session.getRecoveryStatusForClient()).resolves.toEqual({
        kind: 'clean',
        canContinue: false,
      });
      expect(classify).toHaveBeenCalledOnce();
      expect(
        mockChatRecordingService.readActiveTranscriptChain,
      ).not.toHaveBeenCalled();
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('accepts an interrupted prompt as the classification only, without firing the turn itself', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'unanswered question' }] },
      ]);
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      const result = await session.continueLastTurn();

      expect(result).toEqual({
        accepted: true,
        interruption: 'interrupted_prompt',
      });
      expect(session.getRecoveryStatus()).toEqual({
        kind: 'interrupted_prompt',
        canContinue: true,
      });
      // continueLastTurn is now a pure accept/reject pre-check — the daemon
      // bridge drives the actual turn through sendPrompt, so the agent must NOT
      // fire its own internal prompt() here.
      await Promise.resolve();
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('classifies a turn with dangling tool calls as interrupted_turn', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'read it' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call-1', name: 'read_file', args: {} } },
          ],
        },
      ]);
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      const result = await session.continueLastTurn();

      expect(result).toEqual({
        accepted: true,
        interruption: 'interrupted_turn',
      });
      expect(session.getRecoveryStatus()).toEqual({
        kind: 'interrupted_turn',
        canContinue: true,
      });
      // continueLastTurn is decision-only for interrupted_turn too — the bridge
      // drives the turn, so the agent must not fire its own prompt() here.
      await Promise.resolve();
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('rejects when the gemini client is not initialized', async () => {
      vi.mocked(mockLlmClient.isInitialized).mockReturnValue(false);
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      const result = await session.continueLastTurn();

      expect(result).toEqual({ accepted: false, interruption: 'none' });
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it.each(['runtime', 'legacy'] as const)(
      'rejects %s history gaps both in the status and before execution',
      async (source) => {
        vi.mocked(mockChat.getHistory).mockReturnValue([
          { role: 'user', parts: [{ text: 'unanswered' }] },
        ]);
        expect(await session.continueLastTurn()).toEqual({
          accepted: true,
          interruption: 'interrupted_prompt',
        });

        const historyGaps = [
          { childUuid: 'child', missingParentUuid: 'missing' },
        ];
        Object.assign(mockConfig, {
          getSessionRestoreRuntime: vi.fn().mockReturnValue({
            historyGaps: source === 'runtime' ? historyGaps : [],
          }),
          getResumedSessionData: vi.fn().mockReturnValue({
            historyGaps: source === 'legacy' ? historyGaps : [],
          }),
        });

        expect(session.getRecoveryStatus()).toEqual({
          kind: 'degraded_history',
          canContinue: false,
        });
        expect(await session.continueLastTurn()).toEqual({
          accepted: false,
          interruption: 'none',
        });
        expect(
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [],
            _meta: { 'qwen.daemon.continueLastTurn': true },
          }),
        ).toEqual({ stopReason: 'end_turn' });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          mockChat.stripOrphanedUserEntriesFromHistory,
        ).not.toHaveBeenCalled();
      },
    );

    it.each([
      '550e8400-e29b-41d4-a716-446655440000',
      '550E8400-E29B-41D4-A716-446655440000',
    ])(
      'retains finalized history gaps for %s only in its original session',
      async (storageSessionId) => {
        const restoreRuntime = vi.fn().mockReturnValue({
          historyGaps: [{ childUuid: 'child', missingParentUuid: 'missing' }],
        });
        Object.assign(mockConfig, {
          getSessionRestoreRuntime: restoreRuntime,
          getResumedSessionData: vi.fn().mockReturnValue(undefined),
        });
        vi.mocked(mockConfig.getSessionId).mockReturnValue(storageSessionId);
        session.dispose();
        session = new Session(
          storageSessionId.toLowerCase(),
          mockConfig,
          mockClient,
          mockSettings,
        );
        restoreRuntime.mockReturnValue(undefined);
        vi.mocked(mockChat.getHistory).mockReturnValue([
          { role: 'user', parts: [{ text: 'unanswered' }] },
        ]);

        expect(session.getRecoveryStatus()).toEqual({
          kind: 'degraded_history',
          canContinue: false,
        });
        expect(await session.continueLastTurn()).toEqual({
          accepted: false,
          interruption: 'none',
        });
        await session.prompt({
          sessionId: storageSessionId.toLowerCase(),
          prompt: [],
          _meta: { 'qwen.daemon.continueLastTurn': true },
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          mockChat.stripOrphanedUserEntriesFromHistory,
        ).not.toHaveBeenCalled();

        vi.mocked(mockConfig.getSessionId).mockReturnValue('new-session-id');
        expect(session.getRecoveryStatus()).toEqual({
          kind: 'interrupted_prompt',
          canContinue: true,
        });
      },
    );

    it.each(['retry', 'continue'] as const)(
      'preserves the stripped prompt identity when resending through %s',
      async (mode) => {
        const promptId = 'test-session-id########7';
        const orphan: Content = {
          role: 'user',
          parts: [{ text: 'unanswered' }],
        };
        markApiHistoryPrompt(orphan, promptId);
        vi.mocked(mockChat.getHistory).mockReturnValue([orphan]);
        vi.mocked(mockChat.stripOrphanedUserEntriesFromHistory).mockReturnValue(
          [orphan],
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt:
            mode === 'retry' ? [{ type: 'text', text: 'unanswered' }] : [],
          _meta: {
            [mode === 'retry'
              ? 'qwen.daemon.retry'
              : 'qwen.daemon.continueLastTurn']: true,
          },
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledWith(
          currentModel,
          expect.any(Object),
          expect.any(String),
          undefined,
          { promptId },
        );
        expect(
          mockChatRecordingService.recordUserMessage,
        ).not.toHaveBeenCalled();
      },
    );

    it('preserves the orphaned turn when a continuation send fails (no data loss)', async () => {
      // An interrupted prompt: an orphaned user turn the model never answered.
      const promptId = 'test-session-id########7';
      const orphan: Content = {
        role: 'user',
        parts: [{ text: 'unanswered' }],
      };
      markApiHistoryPrompt(orphan, promptId);
      vi.mocked(mockChat.getHistory).mockReturnValue([orphan]);
      vi.mocked(mockChat.stripOrphanedUserEntriesFromHistory).mockReturnValue([
        orphan,
      ]);
      // Force the continuation send to fail NON-cancelled (session token limit)
      // so it hits the `!responseStream` branch — the data-loss window.
      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
      mockLlmClient.tryCompressChat.mockResolvedValue({
        originalTokenCount: 999,
        newTokenCount: 999,
        compressionStatus: core.CompressionStatus.NOOP,
      });

      const continueRequest = {
        prompt: [],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.continueLastTurn': true },
      } as unknown as Parameters<typeof session.prompt>[0];
      const result = await session.prompt(continueRequest);

      expect(result).toEqual({ stopReason: 'max_tokens' });
      // The orphan was stripped before the send; on a non-cancelled failure the
      // full message must be preserved back into history, not dropped.
      expect(mockChat.stripOrphanedUserEntriesFromHistory).toHaveBeenCalled();
      expect(mockChat.addHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'unanswered' }),
          ]),
        }),
      );
      expect(
        getApiHistoryPromptId(vi.mocked(mockChat.addHistory).mock.calls[0]![0]),
      ).toBe(promptId);
    });

    it('restores the orphaned turn when a continuation send throws (no data loss)', async () => {
      // Same data-loss window as above, but the send THROWS instead of
      // returning a graceful null stream — the path #preserveUnsentMessageHistory
      // misses. The catch must restore the stripped orphan.
      mockChat.getHistory = vi
        .fn()
        .mockReturnValue([{ role: 'user', parts: [{ text: 'unanswered' }] }]);
      mockChat.stripOrphanedUserEntriesFromHistory = vi
        .fn()
        .mockReturnValue([{ role: 'user', parts: [{ text: 'unanswered' }] }]);
      // No token limit, so we reach the send; the send then throws.
      mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(0);
      mockChat.sendMessageStream = vi
        .fn()
        .mockRejectedValue(new Error('send blew up'));

      const continueRequest = {
        prompt: [],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.continueLastTurn': true },
      } as unknown as Parameters<typeof session.prompt>[0];

      await expect(session.prompt(continueRequest)).rejects.toThrow(
        'send blew up',
      );

      expect(mockChat.stripOrphanedUserEntriesFromHistory).toHaveBeenCalled();
      expect(mockChat.addHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({ text: 'unanswered' }),
          ]),
        }),
      );
    });

    it('keeps a fresh turn rewindable when it is cancelled before the send', async () => {
      // A fresh turn's mark used to be delegated to the send
      // (llm-chat.ts markApiHistoryPrompt), so a cancellation arriving
      // before the send left the pushed history entry unmarked — the turn
      // stayed unrewindable for the rest of the session (R1-3).
      let releaseCompression!: () => void;
      const compressionGate = new Promise<void>((resolve) => {
        releaseCompression = resolve;
      });
      mockLlmClient.tryCompressChat.mockImplementation(async () => {
        await compressionGate;
        return {
          originalTokenCount: 1,
          newTokenCount: 1,
          compressionStatus: core.CompressionStatus.NOOP,
        };
      });

      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });
      await vi.waitFor(() =>
        expect(mockLlmClient.tryCompressChat).toHaveBeenCalled(),
      );
      // Cancel while the turn is still in pre-send compression: the send is
      // never reached, so the send-path mark never runs either.
      await session.cancelPendingPrompt();
      releaseCompression();
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });

      expect(mockChat.addHistory).toHaveBeenCalled();
      const [pushedEntry] = vi.mocked(mockChat.addHistory).mock.calls[0]!;
      const promptId = getApiHistoryPromptId(pushedEntry);
      expect(promptId).toMatch(/^test-session-id########\d+$/);
      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        undefined,
        promptId,
        undefined,
      );

      // The recorder boundary and the file snapshot exist for this turn;
      // with the entry marked at push time, the cut point resolves instead
      // of refusing for the rest of the session.
      mockChatRecordingService.getRewindTurnIndex.mockImplementation(
        (id: string) => (id === promptId ? 0 : -1),
      );
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([pushedEntry]);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue([
        {
          promptId,
          timestamp: new Date('2026-10-11T00:00:00.000Z'),
          trackedFileBackups: {},
        },
      ]);

      expect(session.getRewindCutPoint(promptId!)).toBe(0);
    });

    it("keeps a continued turn's stripped identity when cancelled before the send", async () => {
      // A retry/continuation reuses the identity of the entries it stripped.
      // The pre-send cancel path used to re-stamp that entry with the
      // transport id — the previous turn's mark — which duplicated an earlier
      // turn under the unique-match resolver and made both refuse.
      const previous: Content = {
        role: 'user',
        parts: [{ text: 'previous prompt' }],
      };
      markApiHistoryPrompt(previous, 'previous-prompt');
      const orphan: Content = { role: 'user', parts: [{ text: 'unanswered' }] };
      markApiHistoryPrompt(orphan, 'continued-prompt');
      mockChat.getHistory = vi.fn().mockReturnValue([previous]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([previous]);
      mockChat.stripOrphanedUserEntriesFromHistory = vi
        .fn()
        .mockReturnValue([orphan]);

      let releaseCompression!: () => void;
      const compressionGate = new Promise<void>((resolve) => {
        releaseCompression = resolve;
      });
      mockLlmClient.tryCompressChat.mockImplementation(async () => {
        await compressionGate;
        return {
          originalTokenCount: 1,
          newTokenCount: 1,
          compressionStatus: core.CompressionStatus.NOOP,
        };
      });

      const prompt = session.prompt({
        prompt: [],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.continueLastTurn': true },
      } as unknown as Parameters<typeof session.prompt>[0]);
      await vi.waitFor(() =>
        expect(mockLlmClient.tryCompressChat).toHaveBeenCalled(),
      );
      await session.cancelPendingPrompt();
      releaseCompression();
      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });

      const pushed = vi.mocked(mockChat.addHistory).mock.calls.at(-1)![0];
      expect(getApiHistoryPromptId(pushed)).toBe('continued-prompt');
    });

    it('does not lend a live prompt id to a retry that stripped nothing', async () => {
      // A retry whose history tail is a model entry strips nothing, so it has
      // no identity of its own to reuse. Lending the last live id would stamp
      // a second entry with the previous turn's mark, and the unique-match
      // resolver would then refuse both turns for the rest of the session.
      const previous: Content = { role: 'user', parts: [{ text: 'previous' }] };
      markApiHistoryPrompt(previous, 'previous-prompt');
      const history: Content[] = [
        previous,
        { role: 'model', parts: [{ text: 'first answer' }] },
      ];
      mockChat.getHistory = vi.fn().mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      mockChat.stripOrphanedUserEntriesFromHistory = vi
        .fn()
        .mockReturnValue([]);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'retried' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        prompt: [],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.retry': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      const sendOptions = vi.mocked(mockChat.sendMessageStream).mock
        .calls[0][4];
      expect(sendOptions).toBeUndefined();
    });

    it('does not re-lend an id that is still live after a retry strips only a continuation', async () => {
      // A fresh turn cancelled between tool laps pushes a continuation
      // stamped with the turn's own id. A retry then strips that trailing
      // continuation only: the prompt entry carrying the same id survives,
      // so lending the id again would duplicate the mark and make the
      // unique-match resolver refuse the turn (R11-1).
      const promptId = 'test-session-id########7';
      const promptEntry: Content = {
        role: 'user',
        parts: [{ text: 'cancelled turn' }],
      };
      markApiHistoryPrompt(promptEntry, promptId);
      const continuation: Content = {
        role: 'user',
        parts: [
          { functionResponse: { id: 'call-1', name: 'read', response: {} } },
        ],
      };
      markApiHistoryPrompt(continuation, promptId);
      mockChat.getHistory = vi.fn().mockReturnValue([promptEntry]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([promptEntry]);
      mockChat.stripOrphanedUserEntriesFromHistory = vi
        .fn()
        .mockReturnValue([continuation]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        prompt: [{ type: 'text', text: 'cancelled turn' }],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.retry': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      const sendOptions = vi.mocked(mockChat.sendMessageStream).mock
        .calls[0][4];
      expect(sendOptions).toBeUndefined();
    });

    it('re-lends the newest stripped id when a retry strips two orphans', async () => {
      // Two turns cancelled before their send leave an orphan run that the
      // strip hands back in history order, so the first dead id belongs to an
      // older turn. The recorder keys the retried turn by its newest id;
      // lending the older one would mark the re-send P1 while the recorder
      // files it under P2, and cutPoint('P2') would then refuse the turn
      // the user just retried (R11-1 arm 2).
      const settled: Content = { role: 'user', parts: [{ text: 'settled' }] };
      markApiHistoryPrompt(settled, 'test-session-id########5');
      const older: Content = { role: 'user', parts: [{ text: 'first' }] };
      markApiHistoryPrompt(older, 'test-session-id########6');
      const newer: Content = { role: 'user', parts: [{ text: 'second' }] };
      markApiHistoryPrompt(newer, 'test-session-id########7');
      mockChat.getHistory = vi.fn().mockReturnValue([settled]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([settled]);
      mockChat.stripOrphanedUserEntriesFromHistory = vi
        .fn()
        .mockReturnValue([older, newer]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        prompt: [{ type: 'text', text: 'second' }],
        sessionId: 'test-session-id',
        _meta: { 'qwen.daemon.retry': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      const sendOptions = vi.mocked(mockChat.sendMessageStream).mock
        .calls[0][4];
      expect(sendOptions).toEqual({ promptId: 'test-session-id########7' });
    });

    it('associates a recording-disabled fresh prompt with its admitted daemon identity', async () => {
      vi.mocked(mockConfig.getChatRecordingService).mockReturnValue(undefined);
      const snapshots: core.FileHistorySnapshot[] = [];
      vi.mocked(mockFileHistoryService.getSnapshots).mockImplementation(
        () => snapshots,
      );
      vi.mocked(mockFileHistoryService.makeSnapshot).mockImplementation(
        async (promptId: string) => {
          snapshots.push({
            promptId,
            timestamp: new Date('2026-10-13T00:00:00Z'),
            trackedFileBackups: {},
          });
        },
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockLlmClient.tryCompressChat.mockImplementation(async () => {
        await gate;
        return {
          originalTokenCount: 1,
          newTokenCount: 1,
          compressionStatus: core.CompressionStatus.NOOP,
        };
      });
      const pending = session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'fresh prompt' }],
        },
        { version: 1, sessionId: 'test-session-id', promptId: 'daemon-fresh' },
      );
      await vi.waitFor(() =>
        expect(mockLlmClient.tryCompressChat).toHaveBeenCalled(),
      );
      await session.cancelPendingPrompt();
      release();
      await expect(pending).resolves.toMatchObject({ stopReason: 'cancelled' });
      const snapshot = snapshots.at(-1)!;
      expect(snapshot.promptId).toMatch(/^test-session-id########\d+$/);
      expect(session.getRewindDaemonPromptId(snapshot.promptId)).toBe(
        'daemon-fresh',
      );
      expect(session.getRewindDaemonPromptId('unknown')).toBeUndefined();
      const [entry] = vi.mocked(mockChat.addHistory).mock.calls.at(-1)!;
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([entry]);
      expect(session.rewindToTurn(0, { rewindFiles: false })).toEqual({
        targetTurnIndex: 0,
        apiTruncateIndex: 0,
        daemonPromptId: 'daemon-fresh',
      });
    });

    it('rejects (accepted:false) when a prompt is already in flight', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'unanswered' }] },
      ]);
      // Simulate an active prompt so the re-entrancy guard trips: there is no
      // settled turn to continue while one is running.
      (
        session as unknown as { pendingPrompt: AbortController | null }
      ).pendingPrompt = new AbortController();
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      const result = await session.continueLastTurn();

      expect(result).toEqual({
        accepted: false,
        interruption: 'interrupted_prompt',
      });
      expect(session.getRecoveryStatus()).toEqual({
        kind: 'interrupted_prompt',
        canContinue: false,
      });
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('reports clean for a restored session whose tail is an unanswered notification', async () => {
      // The daemon persists every background notification before its automatic
      // turn runs. When such a notification's turn never ran, a cold load
      // projects it as a plain `role: 'user'` tail (the record's subtype and
      // provenance do not survive into `Content`) that nothing will ever
      // answer — so the session used to come back as `interrupted_prompt`, with
      // the recovery banner pinned on a turn that had ended with `end_turn`.
      // Drive the same projection `GeminiClient` seeds the live chat with on
      // restore (`buildSessionHistoryFromConversation`).
      const notificationRecord = (index: number, summary: string) => ({
        uuid: `m-${index}`,
        parentUuid: index === 0 ? null : `m-${index - 1}`,
        sessionId: 'test-session-id',
        timestamp: '2026-09-16T00:00:00.000Z',
        type: 'user' as const,
        subtype: 'notification' as const,
        provenance: 'system' as const,
        cwd: '/tmp/project',
        version: 'test',
        message: {
          role: 'user',
          parts: [
            {
              text:
                `<task-notification><task-id>agent-1</task-id>` +
                `<status>completed</status><summary>${summary}</summary>` +
                `</task-notification>`,
            },
          ],
        },
        systemPayload: { displayText: 'Background task completed.' },
      });
      const restored = core.buildSessionHistoryFromConversation({
        messages: [
          {
            uuid: 'm-0',
            parentUuid: null,
            sessionId: 'test-session-id',
            timestamp: '2026-09-16T00:00:00.000Z',
            type: 'user' as const,
            cwd: '/tmp/project',
            version: 'test',
            message: {
              role: 'user',
              parts: [{ text: 'run it in the background' }],
            },
          },
          {
            uuid: 'm-1',
            parentUuid: 'm-0',
            sessionId: 'test-session-id',
            timestamp: '2026-09-16T00:00:01.000Z',
            type: 'assistant' as const,
            cwd: '/tmp/project',
            version: 'test',
            message: { role: 'model', parts: [{ text: 'all done' }] },
          },
          notificationRecord(2, 'Agent "explore" completed.'),
          notificationRecord(3, 'Agent "build" completed.'),
        ],
      });
      // Sanity: the projection really does end in unanswered user entries, so
      // this exercises the classifier instead of an already-clean tail.
      expect(restored.apiHistory.at(-1)?.role).toBe('user');
      vi.mocked(mockChat.getHistory).mockReturnValue(restored.apiHistory);
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      expect(session.getRecoveryStatus()).toEqual({
        kind: 'clean',
        canContinue: false,
      });
      expect(await session.continueLastTurn()).toEqual({
        accepted: false,
        interruption: 'none',
      });
      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('rejects when an automatic notification turn is in flight', async () => {
      // The harmful half: a notification turn runs under
      // `notificationAbortController` and never installs `pendingPrompt`, so the
      // re-entrancy guard used to miss it and report `canContinue: true`. The
      // bridge then drives the continuation through the normal prompt-admission
      // path, which aborts `notificationAbortController` — the recovery button
      // killed a healthy turn.
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'unanswered' }] },
      ]);
      const internals = session as unknown as {
        notificationAbortController: AbortController | null;
        notificationProcessing: boolean;
      };
      const liveTurn = new AbortController();
      internals.notificationAbortController = liveTurn;
      internals.notificationProcessing = true;
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      try {
        expect(session.getRecoveryStatus()).toEqual({
          kind: 'interrupted_prompt',
          canContinue: false,
        });
        expect(await session.continueLastTurn()).toEqual({
          accepted: false,
          interruption: 'interrupted_prompt',
        });
        expect(promptSpy).not.toHaveBeenCalled();
        expect(liveTurn.signal.aborted).toBe(false);
      } finally {
        internals.notificationAbortController = null;
        internals.notificationProcessing = false;
      }
    });

    it('rejects when an automatic cron turn is in flight', async () => {
      // Same guard gap as the notification turn: cron runs under
      // `cronAbortController`, which prompt admission aborts as well.
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'unanswered' }] },
      ]);
      const internals = session as unknown as {
        cronAbortController: AbortController | null;
        cronProcessing: boolean;
      };
      const liveTurn = new AbortController();
      internals.cronAbortController = liveTurn;
      internals.cronProcessing = true;

      try {
        expect(session.getRecoveryStatus()).toEqual({
          kind: 'interrupted_prompt',
          canContinue: false,
        });
        expect(await session.continueLastTurn()).toEqual({
          accepted: false,
          interruption: 'interrupted_prompt',
        });
        expect(liveTurn.signal.aborted).toBe(false);
      } finally {
        internals.cronAbortController = null;
        internals.cronProcessing = false;
      }
    });

    it('rejects while a close gate is held even though no turn is in flight', async () => {
      // `#hasActiveTurn()` has no member for `closing`, yet
      // `assertCanStartTurn()` rejects on it as its FIRST statement. A close
      // gate held while every turn has already settled (`beginClose()` across
      // `waitForActiveTurnsToSettle()`, or a disposed session) therefore used
      // to report `canContinue: true`: the banner offered Continue,
      // `continueLastTurn()` accepted, and the bridge drove the continuation
      // into `'Session is closing'` — the accept-then-fail round trip this
      // guard exists to prevent. Set the private flag the way the sibling
      // tests set `notificationProcessing`.
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'unanswered' }] },
      ]);
      const internals = session as unknown as { closing: boolean };
      internals.closing = true;
      const promptSpy = vi
        .spyOn(session, 'prompt')
        .mockResolvedValue({ stopReason: 'end_turn' });

      try {
        expect(session.getRecoveryStatus()).toEqual({
          kind: 'interrupted_prompt',
          canContinue: false,
        });
        expect(await session.continueLastTurn()).toEqual({
          accepted: false,
          interruption: 'interrupted_prompt',
        });
        expect(promptSpy).not.toHaveBeenCalled();
      } finally {
        internals.closing = false;
      }
    });

    it('recovers a FAILED automatic notification turn that carries reminders', async () => {
      // Sibling of the in-flight case above, for the state where the turn is
      // already over. A notification turn pushes its
      // `[...systemReminders, ...notificationParts]` user entry into live
      // history before any attempt; if the stream then fails mid-turn with no
      // `functionCall` delivered, no model entry is pushed, so that entry IS
      // the tail — and the `catch` does not re-queue while the `finally`
      // clears `notificationAbortController`, so `#hasActiveTurn()` is false.
      // Trimming that entry as structural certifies `clean` and leaves the
      // turn with no re-drive at all (`persistedBackgroundNotificationTaskIds`
      // already holds the taskId). Nothing is in flight here, on purpose.
      vi.mocked(mockChat.getHistory).mockReturnValue([
        { role: 'user', parts: [{ text: 'earlier prompt' }] },
        { role: 'model', parts: [{ text: 'earlier answer' }] },
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nplan mode is active\n</system-reminder>',
            },
            {
              text:
                `<task-notification><task-id>agent-1</task-id>` +
                `<status>failed</status>` +
                `<summary>Agent "explore" failed.</summary>` +
                `</task-notification>`,
            },
          ],
        },
      ]);

      expect(session.getRecoveryStatus()).toEqual({
        kind: 'interrupted_prompt',
        canContinue: true,
      });
      expect(await session.continueLastTurn()).toEqual({
        accepted: true,
        interruption: 'interrupted_prompt',
      });
    });
  });

  describe('restoreAskUserQuestion prompt', () => {
    beforeEach(() => {
      vi.mocked(mockConfig.getRestoreAskUserQuestion).mockReturnValue(true);
    });

    const auqArgs = {
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
    };

    function danglingAuqHistory(): Content[] {
      return [
        { role: 'user', parts: [{ text: 'pick one' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq',
                name: 'ask_user_question',
                args: auqArgs,
              },
            },
          ],
        },
      ];
    }

    it('does not classify a restorable question as an interrupted tool turn', async () => {
      vi.mocked(mockChat.getHistory).mockReturnValue(danglingAuqHistory());

      expect(session.getRecoveryStatus()).toEqual({
        kind: 'clean',
        canContinue: false,
      });
      expect(await session.continueLastTurn()).toEqual({
        accepted: false,
        interruption: 'none',
      });
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    });

    it('requests permission and continues with the real function response', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'User answers:\nQuestion: Polling',
        returnDisplay: 'answered',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('ask_user_question', execute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result).toEqual({ stopReason: 'end_turn' });
      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            toolCallId: 'call-auq',
            _meta: expect.objectContaining({
              qwenInteractionKind: 'user_question',
            }),
          }),
        }),
      );
      expect(execute).toHaveBeenCalled();
      const sent = firstSentMessage();
      expect(sent[0]?.functionResponse?.id).toBe('call-auq');
      expect(sent[0]?.functionResponse?.name).toBe('ask_user_question');
    });

    it('on the shared loop, asks with its own executor and sends the answer as a Retry', async () => {
      mockConfig.isUnifiedAgentLoopEnabled = vi.fn().mockReturnValue(true);
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'User answers:\nQuestion: Polling',
        returnDisplay: 'answered',
      });
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('ask_user_question', execute),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      const send = vi.fn(() =>
        (async function* () {
          yield { type: core.LlmEventType.Content, value: 'got it' };
          yield {
            type: core.LlmEventType.Finished,
            value: { reason: FinishReason.STOP },
          };
        })(),
      );
      Object.assign(mockLlmClient, { sendMessageStream: send });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result).toEqual({ stopReason: 'end_turn' });
      // The restored question keeps the session's executor for now.
      expect(runAcpToolBatchSpy).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalled();
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledOnce();
      const [parts, , , options] = send.mock.calls[0] as unknown as [
        Part[],
        AbortSignal,
        string,
        { type: string; userTurnRecordedByHost?: boolean },
      ];
      expect(parts[0]?.functionResponse?.id).toBe('call-auq');
      expect(options).toMatchObject({
        type: core.SendMessageType.Retry,
        userTurnRecordedByHost: true,
      });
      expect(options).not.toHaveProperty('promptAdmission');
    });

    describe('on the shared loop, with notices waiting for the answer', () => {
      let pushes: number;
      let send: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        mockConfig.isUnifiedAgentLoopEnabled = vi.fn().mockReturnValue(true);
        mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(
            'ask_user_question',
            vi.fn().mockResolvedValue({
              llmContent: 'User answers:\nQuestion: Polling',
              returnDisplay: 'answered',
            }),
          ),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValue({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
          answers: { '0': 'Polling' },
        });
        pushes = 0;
        Object.assign(mockChat, {
          getUserContentPushCount: vi.fn(() => pushes),
        });
        send = vi.fn();
        Object.assign(mockLlmClient, { sendMessageStream: send });
        session.pendingWorktreeNotice = 'the worktree is still alive';
      });

      const restore = () =>
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [],
          _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
        } as unknown as Parameters<typeof session.prompt>[0]);

      it('takes the notices once the answer reached history, even if the response fails', async () => {
        send.mockImplementationOnce(() =>
          (async function* () {
            pushes = 1;
            yield {
              type: core.LlmEventType.Error,
              value: { error: { message: 'model failed', status: 500 } },
            };
          })(),
        );

        await expect(restore()).rejects.toThrow();

        expect(session.pendingWorktreeNotice).toBeNull();
      });

      it('keeps the answer with its notices, and takes them, when cancelled before it went out', async () => {
        send.mockImplementationOnce(() =>
          (async function* () {
            await session.cancelPendingPrompt();
            yield { type: core.LlmEventType.UserCancelled };
          })(),
        );

        await expect(restore()).resolves.toMatchObject({
          stopReason: 'cancelled',
        });

        expect(mockChat.addHistory).toHaveBeenCalledWith(
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('the worktree is still alive'),
              }),
            ]),
          }),
        );
        expect(session.pendingWorktreeNotice).toBeNull();
      });
    });

    it('writes a decline result when the restored question is cancelled', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn();
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          execute,
          'ask_user_question',
          onConfirm,
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
      });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result.stopReason).toBe('end_turn');
      expect(execute).not.toHaveBeenCalled();
      expect(onConfirm).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        expect.anything(),
      );
      expect(mockChat.addHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          parts: expect.arrayContaining([
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-auq',
                name: 'ask_user_question',
              }),
            }),
          ]),
        }),
      );
    });

    it('does not persist the decline when a restored question times out', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn();
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          execute,
          'ask_user_question',
          vi.fn().mockResolvedValue(undefined),
        ),
      );
      // The daemon's permission mediator resolved the wait as an unattended
      // timeout — nobody declined this question.
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
        _meta: { 'qwen.daemon.permissionCancelReason': 'timeout' },
      });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result.stopReason).toBe('end_turn');
      expect(execute).not.toHaveBeenCalled();
      // The transcript keeps the dangling call so a later load can re-hang
      // it — no fabricated "canceled by the user" tool result is persisted.
      expect(
        mockChatRecordingService.recordToolResult,
      ).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({ id: 'call-auq' }),
          }),
        ]),
        expect.anything(),
      );
    });

    it('persists the decline for a deliberate cancel of a restored question', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn();
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          execute,
          'ask_user_question',
          vi.fn().mockResolvedValue(undefined),
        ),
      );
      // A voter cancel carries a non-timeout reason (or, for direct ACP
      // clients, no reason meta at all) — both are deliberate.
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
        _meta: { 'qwen.daemon.permissionCancelReason': 'agent_cancelled' },
      });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result.stopReason).toBe('end_turn');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({ id: 'call-auq' }),
          }),
        ]),
        expect.anything(),
      );
    });

    it('ignores the restore meta key when the config flag is off', async () => {
      vi.mocked(mockConfig.getRestoreAskUserQuestion).mockReturnValue(false);
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn();
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool('ask_user_question', execute),
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            },
          },
        ]),
      );

      // With the flag off the meta key is inert: the prompt goes down the
      // normal path instead of re-hanging the trailing question.
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).toHaveBeenCalled();
    });

    it('bails without per-turn bookkeeping when history is not restorable', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'pick one' }] },
        { role: 'model', parts: [{ text: 'done already' }] },
      ]);

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result).toEqual({ stopReason: 'end_turn' });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      // No phantom file-history snapshot for a turn that never ran.
      expect(mockConfig.getFileHistoryService).not.toHaveBeenCalled();
    });

    it('carries a pending worktree notice on the post-answer model message', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );
      const notice =
        '[Resumed] Active worktree: "feat" at /repo/.qwen/worktrees/feat';
      session.pendingWorktreeNotice = notice;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      const sent = firstSentMessage();
      expect(sent[0]?.functionResponse?.id).toBe('call-auq');
      expect(
        sent.some(
          (part) =>
            typeof part.text === 'string' &&
            part.text.includes('<system-reminder>') &&
            part.text.includes(notice),
        ),
      ).toBe(true);
      expect(session.pendingWorktreeNotice).toBeNull();
    });

    it('carries initial system reminders on the post-answer model message', async () => {
      vi.mocked(mockConfig.getApprovalMode).mockReturnValue(ApprovalMode.PLAN);
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      const sent = firstSentMessage();
      expect(sent[0]?.functionResponse?.id).toBe('call-auq');
      expect(
        sent.some(
          (part) =>
            typeof part.text === 'string' &&
            part.text.includes('Plan mode is active'),
        ),
      ).toBe(true);
    });

    it('does not take the active-todo reminder on the restore turn', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      // The forced take (second arg `true`) burns the reminder and resets its
      // refresh counter; the restore turn discards `parts`, so it must never
      // force-take. The post-answer message may still pick the reminder up
      // via the non-forced take in #buildNextMessageAfterToolRun.
      expect(mockConfig.takeActiveTodoReminder).not.toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
    });

    it('keeps the worktree notice and emits conversation_finished on cancel', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn(),
          'ask_user_question',
          vi.fn().mockResolvedValue(undefined),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
      });
      const finishedSpy = vi
        .spyOn(core, 'logConversationFinishedEvent')
        .mockImplementation(() => {});
      const notice = 'worktree restore notice';
      session.pendingWorktreeNotice = notice;

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result.stopReason).toBe('end_turn');
      expect(session.pendingWorktreeNotice).toBe(notice);
      expect(finishedSpy).toHaveBeenCalledTimes(1);
    });

    it('does not persist the decline when a restored question is session_closed', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      const execute = vi.fn();
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          execute,
          'ask_user_question',
          vi.fn().mockResolvedValue(undefined),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
        _meta: { 'qwen.daemon.permissionCancelReason': 'session_closed' },
      });

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(result.stopReason).toBe('end_turn');
      expect(
        mockChatRecordingService.recordToolResult,
      ).not.toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({ id: 'call-auq' }),
          }),
        ]),
        expect.anything(),
      );
    });

    it('does not persist skipped siblings when a restored batch times out', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'pick two' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq-a',
                name: 'ask_user_question',
                args: auqArgs,
              },
            },
            {
              functionCall: {
                id: 'call-auq-b',
                name: 'ask_user_question',
                args: auqArgs,
              },
            },
          ],
        },
      ]);
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn(),
          'ask_user_question',
          vi.fn().mockResolvedValue(undefined),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'cancelled' },
        _meta: { 'qwen.daemon.permissionCancelReason': 'timeout' },
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockChatRecordingService.recordToolResult).not.toHaveBeenCalled();
    });

    it('does not persist the answered sibling when the rest of the restored batch times out', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue([
        { role: 'user', parts: [{ text: 'pick two' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-auq-a',
                name: 'ask_user_question',
                args: auqArgs,
              },
            },
            {
              functionCall: {
                id: 'call-auq-b',
                name: 'ask_user_question',
                args: auqArgs,
              },
            },
          ],
        },
      ]);
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission)
        .mockResolvedValueOnce({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
          answers: { '0': 'Polling' },
        })
        .mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
          _meta: { 'qwen.daemon.permissionCancelReason': 'timeout' },
        });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      // Persisting the answered sibling would leave a user turn after the
      // dangling model turn, making the batch unrestorable on the next load.
      expect(mockChatRecordingService.recordToolResult).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'resolves after the abort',
        permissionResult: {
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
          answers: { '0': 'Polling' },
        } as const,
        reject: false,
      },
      {
        label: 'rejects after the abort',
        permissionResult: new Error('permission transport closed'),
        reject: true,
      },
    ])(
      'does not persist a restored ask_user_question whose permission wait is aborted ($label)',
      async ({ permissionResult, reject }) => {
        mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool('ask_user_question', vi.fn()),
        );
        vi.mocked(mockClient.requestPermission).mockImplementation(async () => {
          // The abort carries no permissionCancelReason meta, so only the
          // wasAborted mark can keep the fabricated result off disk.
          await session.cancelPendingPrompt();
          if (reject) throw permissionResult;
          return permissionResult;
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [],
          _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
        } as unknown as Parameters<typeof session.prompt>[0]);

        expect(
          mockChatRecordingService.recordToolResult,
        ).not.toHaveBeenCalled();
      },
    );

    it('carries a pending recovered-agents notice on the post-answer message', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );
      const notice = 'Recovered background agents: researcher';
      session.pendingRecoveredAgentsNotice = notice;

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      const sent = firstSentMessage();
      expect(
        sent.some(
          (part) =>
            typeof part.text === 'string' &&
            part.text.includes('<system-reminder>') &&
            part.text.includes(notice),
        ),
      ).toBe(true);
      expect(session.pendingRecoveredAgentsNotice).toBeNull();
    });

    it('keeps the worktree notice when the post-answer send fails', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockRejectedValue(new Error('compression failed'));
      const notice = 'worktree restore notice';
      session.pendingWorktreeNotice = notice;

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [],
          _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
        } as unknown as Parameters<typeof session.prompt>[0]),
      ).rejects.toThrow('compression failed');

      expect(session.pendingWorktreeNotice).toBe(notice);
    });

    it('does not snapshot file history on a restore continuation', async () => {
      mockChat.getHistory = vi.fn().mockReturnValue(danglingAuqHistory());
      mockToolRegistry.getTool.mockReturnValue(
        mockConfirmingTool(
          'ask_user_question',
          vi.fn().mockResolvedValue({
            llmContent: 'User answers:\nQuestion: Polling',
            returnDisplay: 'answered',
          }),
        ),
      );
      vi.mocked(mockClient.requestPermission).mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Polling' },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'got it' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [],
        _meta: { 'qwen.daemon.restoreAskUserQuestion': true },
      } as unknown as Parameters<typeof session.prompt>[0]);

      expect(mockFileHistoryService.makeSnapshot).not.toHaveBeenCalled();
      expect(
        mockChatRecordingService.recordFileHistorySnapshot,
      ).not.toHaveBeenCalled();
    });
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

  it('forwards the expected Plan execution policy from permission response to confirmation', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    vi.mocked(mockClient.requestPermission).mockImplementationOnce(
      async () => ({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        expectedPlanExecutionMode: 'yolo',
      }),
    );

    await runExitPlanModeApprovalPrompt(onConfirm);

    expect(onConfirm).toHaveBeenCalledWith(
      core.ToolConfirmationOutcome.ProceedOnce,
      expect.objectContaining({ expectedPlanExecutionMode: 'yolo' }),
    );
  });

  describe('DAC plan approval through Session', () => {
    let mode: ApprovalMode;
    let policy: ApprovalMode | undefined;
    let revision: number;

    beforeEach(() => {
      mode = ApprovalMode.PLAN;
      policy = ApprovalMode.YOLO;
      revision = 1;
      mockConfig.getApprovalMode = vi.fn(() => mode);
      mockConfig.getPlanExecutionMode = vi.fn(() => policy);
      mockConfig.getPrePlanMode = vi.fn(() => ApprovalMode.DEFAULT);
      mockConfig.getApprovalModeRevision = vi.fn(() => revision);
      mockConfig.setApprovalMode = vi.fn((next) => {
        mode = next;
        policy = undefined;
        revision++;
      });
      mockConfig.getTeamManager = vi.fn();
      mockConfig.savePlan = vi.fn();
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockToolRegistry.getTool.mockReturnValue(
        new ExitPlanModeTool(mockConfig),
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-dac-plan',
                  name: core.ToolNames.EXIT_PLAN_MODE,
                  args: { plan: 'DAC plan' },
                },
              ],
            },
          },
        ]),
      );
    });

    it.each([undefined, ApprovalMode.YOLO])(
      'consumes a missing or stale DAC policy (%s) as a tool error and keeps Plan',
      async (expectedPlanExecutionMode) => {
        vi.mocked(mockClient.requestPermission).mockImplementationOnce(
          async () => {
            policy = ApprovalMode.AUTO_EDIT;
            return {
              outcome: { outcome: 'selected', optionId: 'restore_previous' },
              ...(expectedPlanExecutionMode
                ? { expectedPlanExecutionMode }
                : {}),
            };
          },
        );

        const result = await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'approve the plan' }],
        });

        expect(result.stopReason).toBe('end_turn');
        expect(mockClient.requestPermission).toHaveBeenCalledOnce();
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-dac-plan',
                response: {
                  error: expect.stringContaining(
                    'Execution permission changed',
                  ),
                },
              }),
            }),
          ],
          expect.objectContaining({
            status: 'error',
            errorType: core.ToolErrorType.EXECUTION_DENIED,
            executionStatus: 'not_started',
          }),
        );
        expect(mode).toBe(ApprovalMode.PLAN);
        expect(policy).toBe(ApprovalMode.AUTO_EDIT);
        expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
        expect(mockConfig.savePlan).not.toHaveBeenCalled();
      },
    );

    it('settles an old approval after manual Plan exit without executing its plan', async () => {
      let respond!: (response: RequestPermissionResponse) => void;
      vi.mocked(mockClient.requestPermission).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'approve the plan' }],
      });
      await vi.waitFor(() =>
        expect(mockClient.requestPermission).toHaveBeenCalledOnce(),
      );

      await session.setMode({ sessionId: 'test-session-id', modeId: 'yolo' });
      expect(mode).toBe(ApprovalMode.YOLO);
      respond({
        outcome: { outcome: 'selected', optionId: 'restore_previous' },
      });

      expect((await prompt).stopReason).toBe('end_turn');
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              id: 'call-dac-plan',
              response: {
                output: expect.stringContaining('Plan approval is stale'),
              },
            }),
          }),
        ],
        expect.objectContaining({ status: 'success' }),
      );
      expect(mockConfig.setApprovalMode).toHaveBeenCalledOnce();
      expect(mockConfig.savePlan).not.toHaveBeenCalled();
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(mode).toBe(ApprovalMode.YOLO);
    });
  });

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

  describe('Session Workflow plan revision context', () => {
    it('captures Todo IDs only for an enabled, active revision', async () => {
      const setRevision = vi.fn();
      const clearRevision = vi.fn();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.isSessionWorkflowEnabled = vi.fn().mockReturnValue(true);
      mockConfig.setSessionWorkflowPlanRevision = setRevision;
      mockConfig.clearSessionWorkflowPlanRevision = clearRevision;

      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
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

      expect(setRevision).toHaveBeenCalledWith({
        planId: 'plan-1',
        sourceCallId: 'todo-call-1',
        todoIds: ['inspect', 'ship'],
      });
      expect(clearRevision).toHaveBeenCalledOnce();
    });

    it('requires both the Workflow marker and complete Todo identity', async () => {
      const setRevision = vi.fn();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.isSessionWorkflowEnabled = vi.fn().mockReturnValue(true);
      mockConfig.setSessionWorkflowPlanRevision = setRevision;
      mockConfig.clearSessionWorkflowPlanRevision = vi.fn();

      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
        ],
        _meta: {
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      expect(setRevision).not.toHaveBeenCalled();
    });

    it.each([
      ['an in-progress plan', ['in_progress']],
      ['a partially completed plan', ['completed', 'pending']],
    ] as const)('does not bind %s for approval', async (_label, statuses) => {
      const setRevision = vi.fn();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.isSessionWorkflowEnabled = vi.fn().mockReturnValue(true);
      mockConfig.setSessionWorkflowPlanRevision = setRevision;
      mockConfig.clearSessionWorkflowPlanRevision = vi.fn();

      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: statuses.map((status, index) => ({
          content: `Step ${index + 1}`,
          priority: 'medium',
          status,
          _meta: { qwenTodo: { id: `step-${index + 1}` } },
        })),
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      expect(setRevision).not.toHaveBeenCalled();
    });

    it('keeps the last pending approval snapshot across status-only updates', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      const planUpdate: SessionUpdate = {
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      };
      await session.sendUpdate(planUpdate);

      await session.sendUpdate({
        ...planUpdate,
        entries: [{ ...planUpdate.entries[0]!, status: 'in_progress' }],
        _meta: {
          ...planUpdate._meta,
          qwenTranscript: { planToolCallId: 'todo-call-2' },
        },
      });

      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
        }),
      );
    });

    it('clears the pending approval snapshot when the plan structure changes', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Changed scope',
            priority: 'medium',
            status: 'in_progress',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-2' },
        },
      });

      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });

    it('keeps the approved Todo IDs frozen during execution updates', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      await runExitPlanModeApprovalPrompt();
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect',
            priority: 'medium',
            status: 'in_progress',
            _meta: { qwenTodo: { id: 'inspect' } },
          },
          {
            content: 'Unapproved follow-up',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'follow-up' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-2' },
        },
      });

      expect(mockConfig.getSessionWorkflowPlanRevision?.()).toEqual({
        planId: 'plan-1',
        sourceCallId: 'todo-call-1',
        todoIds: ['inspect'],
      });
    });

    it('clears the revision context on session disposal', () => {
      const clearRevision = vi.fn();
      mockConfig.clearSessionWorkflowPlanRevision = clearRevision;

      session.dispose();

      expect(clearRevision).toHaveBeenCalledOnce();
    });
  });

  describe('setMode', () => {
    it.each([
      ['plan', ApprovalMode.PLAN],
      ['default', ApprovalMode.DEFAULT],
      ['auto-edit', ApprovalMode.AUTO_EDIT],
      ['yolo', ApprovalMode.YOLO],
    ] as const)('maps %s mode', async (modeId, expected) => {
      await session.setMode({
        sessionId: 'test-session-id',
        modeId,
      });

      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(expected);
    });

    it('reports the execution policy when entering Plan', async () => {
      mockConfig.getPrePlanMode = vi.fn(() => ApprovalMode.YOLO);
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/mode-update',
        expect.objectContaining({
          currentModeId: 'plan',
          planExecutionMode: 'yolo',
        }),
      );
    });

    it('emits a current_mode_update extNotification after switching (A2)', async () => {
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'auto-edit',
      });

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/mode-update',
        expect.objectContaining({
          v: 1,
          sessionId: 'test-session-id',
          currentModeId: 'auto-edit',
        }),
      );
    });

    it('rejects an unknown modeId and does NOT touch approval mode (A2)', async () => {
      await expect(
        session.setMode({
          sessionId: 'test-session-id',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          modeId: 'totally-bogus' as any,
        }),
      ).rejects.toThrow(/Unknown approval mode/);

      expect(mockConfig.setApprovalMode).not.toHaveBeenCalled();
      expect(mockClient.extNotification).not.toHaveBeenCalledWith(
        'qwen/notify/session/mode-update',
        expect.anything(),
      );
    });

    it('clears the active Todo plan revision when changing mode', async () => {
      enableSessionWorkflowRevisionContext();
      // Capture requires PLAN mode: sending this update in DEFAULT would never
      // bind a revision, and the assertion below would pass vacuously.
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
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

      const bound = await runExitPlanModeApprovalPrompt();
      expect(bound.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
        }),
      );

      // A user-driven transition into plan mode from a non-plan mode starts a
      // fresh approval cycle, so the bound revision must be dropped.
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });

      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });

    it('preserves the active Todo plan revision when re-selecting plan mode', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
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

      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'plan',
      });

      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
        }),
      );
    });

    it('keeps the approved Todo plan revision when switching between non-plan modes', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
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

      // Approving via exit_plan_mode stamps the revision and leaves PLAN.
      const bound = await runExitPlanModeApprovalPrompt();
      expect(bound.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'plan-1', sourceCallId: 'todo-call-1' },
        }),
      );

      // The approved plan keeps executing in the new mode, so a non-plan →
      // non-plan switch (default → auto-edit) touches no approval cycle and
      // must not disarm the revision mid-execution. (After the helper, the
      // current mode is DEFAULT.)
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'auto-edit',
      });

      expect(mockConfig.getSessionWorkflowPlanRevision?.()).toEqual({
        planId: 'plan-1',
        sourceCallId: 'todo-call-1',
        todoIds: ['ship'],
      });
    });

    it('clears the active Todo plan revision when leaving plan mode', async () => {
      enableSessionWorkflowRevisionContext();
      // Capture requires PLAN mode: bind the revision while the session is
      // still in PLAN, then leave PLAN before any approval happens.
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
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

      // Leaving PLAN abandons the draft approval cycle: the bound revision
      // must be dropped so a later exit_plan_mode approval cannot reuse it.
      // getApprovalMode still reports PLAN here, so this exercises the
      // PLAN → DEFAULT exit side of the transition (the entry side is
      // covered by the 'when changing mode' case above).
      await session.setMode({
        sessionId: 'test-session-id',
        modeId: 'default',
      });

      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });
  });

  describe('output style turn reminder', () => {
    function armStyle(styleName: string | undefined) {
      mockConfig.getOutputStyle = vi
        .fn()
        .mockReturnValue(
          styleName ? core.getBuiltInOutputStyle(styleName) : undefined,
        );
      mockConfig.getSystemPrompt = vi.fn().mockReturnValue(undefined);
      mockConfig.getExperimentalZedIntegration = vi.fn().mockReturnValue(true);
      mockConfig.isInteractive = vi.fn().mockReturnValue(false);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'ok' }] } }],
            },
          },
        ]),
      );
    }

    it('sends the active style reminder with every ACP prompt', async () => {
      armStyle('Concise');

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      expect(textParts(firstSentMessage())).toContainEqual(
        expect.stringMatching(
          /^<system-reminder>\nConcise output style is active\. Be concise:.*\n<\/system-reminder>$/s,
        ),
      );
    });

    it('sends nothing when no style is active', async () => {
      armStyle(undefined);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      expect(
        textParts(firstSentMessage()).some((text) =>
          text.includes('output style is active'),
        ),
      ).toBe(false);
    });

    it('stays silent when a custom system prompt carries no style section', async () => {
      armStyle('Concise');
      mockConfig.getSystemPrompt = vi.fn().mockReturnValue('You are terse.');

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      expect(
        textParts(firstSentMessage()).some((text) =>
          text.includes('output style is active'),
        ),
      ).toBe(false);
    });
  });

  describe('sendCurrentModeUpdateNotification', () => {
    // The exit_plan_mode / edit-ProceedAlways path publishes the legacy
    // `session_update{current_mode_update}` frame itself (via sendUpdate),
    // so its extNotification must carry `legacyFrameSent: true` to stop the
    // bridge demux from emitting a second, duplicate legacy frame. Unlike
    // `setMode` (which omits the flag), a regression dropping it here would
    // double-publish to the IDE companion. (A2)
    it('reports the actual mode and marks a successful legacy frame', async () => {
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.AUTO_EDIT);
      await (
        session as unknown as {
          sendCurrentModeUpdateNotification: () => Promise<void>;
        }
      ).sendCurrentModeUpdateNotification();

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/mode-update',
        expect.objectContaining({
          v: 1,
          sessionId: 'test-session-id',
          currentModeId: 'auto-edit',
          legacyFrameSent: true,
        }),
      );
    });

    it('still sends the side-channel when the legacy notification fails', async () => {
      vi.mocked(mockClient.sessionUpdate).mockRejectedValueOnce(
        new Error('legacy unavailable'),
      );

      await (
        session as unknown as {
          sendCurrentModeUpdateNotification: () => Promise<void>;
        }
      ).sendCurrentModeUpdateNotification();

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/mode-update',
        expect.objectContaining({
          currentModeId: ApprovalMode.DEFAULT,
          legacyFrameSent: false,
        }),
      );
    });
  });

  describe('deleteMessageGroups', () => {
    it('keeps the summary and surviving prompt identities while removing selected raw turns and snapshots', async () => {
      const summary: Content = {
        role: 'user',
        parts: [{ text: 'Existing summary' }],
      };
      const deleted: Content = { role: 'user', parts: [{ text: 'delete me' }] };
      const kept: Content = { role: 'user', parts: [{ text: 'keep me' }] };
      markApiHistoryPrompt(deleted, 'internal-1');
      markApiHistoryPrompt(kept, 'internal-2');
      const history = [
        summary,
        { role: 'model', parts: [{ text: 'ack' }] },
        deleted,
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'tool', name: 'read_file', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'tool',
                name: 'read_file',
                response: { output: 'old contents' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: 'deleted reply' }] },
        kept,
        { role: 'model', parts: [{ text: 'kept reply' }] },
      ];
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      mockChatRecordingService.deleteMessageGroups.mockResolvedValue({
        deletedGroupIds: ['group-1'],
        deletedPromptIds: ['daemon-1'],
        removedApiPromptIds: ['internal-1'],
      });
      mockFileHistoryService.getSnapshots.mockReturnValue([
        { promptId: 'internal-1' },
        { promptId: 'internal-2' },
      ]);
      mockChatRecordingService.readActiveTranscriptChain.mockResolvedValue([
        {
          type: 'system',
          subtype: 'chat_compression',
          uuid: 'compression',
          parentUuid: null,
          systemPayload: {
            compressedHistory: [summary, history[1], kept, history[7]],
            promptIds: [null, null, 'internal-2', null],
          },
        },
      ]);
      await session.deleteMessageGroups({
        snapshot: 'snapshot',
        groupIds: ['group-1'],
      });
      expect(mockLlmClient.setHistory).toHaveBeenCalledWith([
        summary,
        history[1],
        kept,
        history[7],
      ]);
      const installed = vi.mocked(mockChat.setHistory).mock.calls.at(-1)![0];
      expect(installed[0]).toEqual(summary);
      expect(getApiHistoryPromptId(installed[2])).toBe('internal-2');
      expect(mockFileHistoryService.restoreFromSnapshots).toHaveBeenCalledWith([
        { promptId: 'internal-2' },
      ]);
      expect(mockFileHistoryService.rewind).not.toHaveBeenCalled();
      expect(mockLlmClient.tryCompressChat).not.toHaveBeenCalled();
      expect(session.isTurnIdle()).toBe(true);
    });

    it('can remove the only turn and keeps a fully compressed deletion context unchanged', async () => {
      const user: Content = { role: 'user', parts: [{ text: 'only turn' }] };
      markApiHistoryPrompt(user, 'only');
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([
        user,
        { role: 'model', parts: [{ text: 'reply' }] },
      ]);
      mockChatRecordingService.deleteMessageGroups.mockResolvedValue({
        deletedGroupIds: ['only'],
        deletedPromptIds: ['daemon-only'],
        removedApiPromptIds: ['only'],
      });
      await session.deleteMessageGroups({ snapshot: 'v1', groupIds: ['only'] });
      expect(mockLlmClient.setHistory).toHaveBeenLastCalledWith([]);
      const summary = [
        { role: 'user', parts: [{ text: 'summary containing only' }] },
      ];
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(summary);
      mockChatRecordingService.readActiveTranscriptChain.mockResolvedValue([
        {
          type: 'system',
          subtype: 'chat_compression',
          uuid: 'compression',
          parentUuid: null,
          systemPayload: { compressedHistory: summary, promptIds: [null] },
        },
      ]);
      await session.deleteMessageGroups({ snapshot: 'v2', groupIds: ['only'] });
      expect(mockLlmClient.setHistory).toHaveBeenLastCalledWith(summary);
    });

    it('does not change memory or snapshots when persistence fails', async () => {
      mockChatRecordingService.deleteMessageGroups.mockRejectedValue(
        new Error('disk failure'),
      );
      await expect(
        session.deleteMessageGroups({
          snapshot: 'snapshot',
          groupIds: ['group'],
        }),
      ).rejects.toThrow('disk failure');
      expect(mockChat.setHistory).not.toHaveBeenCalled();
      expect(
        mockFileHistoryService.restoreFromSnapshots,
      ).not.toHaveBeenCalled();
      expect(session.isTurnIdle()).toBe(true);
    });

    it('holds admission closed if context installation fails after durable deletion', async () => {
      mockChatRecordingService.deleteMessageGroups.mockResolvedValue({
        deletedGroupIds: ['group'],
        deletedPromptIds: ['prompt'],
        removedApiPromptIds: [],
      });
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue([]);
      vi.mocked(mockChat.setHistory).mockImplementationOnce(() => {
        throw new Error('context failed');
      });
      await expect(
        session.deleteMessageGroups({ snapshot: 'v1', groupIds: ['group'] }),
      ).rejects.toMatchObject({
        data: {
          errorKind: 'message_deletion_context_unavailable',
          deletedGroupIds: ['group'],
        },
      });
      expect(session.isTurnIdle()).toBe(true);
      await expect(session.assertCanStartTurn()).rejects.toMatchObject({
        data: {
          errorKind: 'session_history_context_unavailable',
        },
      });
      await expect(
        session.deleteMessageGroups({ snapshot: 'v2', groupIds: ['other'] }),
      ).rejects.toMatchObject({
        data: { errorKind: 'session_history_context_unavailable' },
      });
      expect(
        mockChatRecordingService.deleteMessageGroups,
      ).toHaveBeenCalledTimes(1);
      await session.waitForActiveTurnsToSettle();
      await session.recoverMessageDeletionContext();
      await expect(session.assertCanStartTurn()).resolves.toBeUndefined();
    });

    it('retains background notifications without spending retries until deleted context recovers', async () => {
      vi.useFakeTimers();
      try {
        mockChatRecordingService.deleteMessageGroups.mockResolvedValue({
          deletedGroupIds: ['group'],
          deletedPromptIds: ['prompt'],
          removedApiPromptIds: [],
        });
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue([]);
        vi.mocked(mockChat.setHistory).mockImplementationOnce(() => {
          throw new Error('context failed');
        });
        await expect(
          session.deleteMessageGroups({ snapshot: 'v1', groupIds: ['group'] }),
        ).rejects.toThrow('reopened');
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(async () => createEmptyStream());
        await session.enqueueBackgroundNotification({
          displayText: 'Worker completed.',
          modelText: '<task-notification />',
          taskId: 'queued-after-delete',
          status: 'completed',
          kind: 'agent',
        });
        await vi.advanceTimersByTimeAsync(8_000);
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          (session as unknown as { notificationAdmissionDeferred: boolean })
            .notificationAdmissionDeferred,
        ).toBe(false);
        await session.recoverMessageDeletionContext();
        await vi.advanceTimersByTimeAsync(1);
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects an active history mutation before touching storage', async () => {
      const release = session.beginHistoryMutation();
      await expect(
        session.deleteMessageGroups({
          snapshot: 'snapshot',
          groupIds: ['group'],
        }),
      ).rejects.toThrow('busy');
      expect(
        mockChatRecordingService.deleteMessageGroups,
      ).not.toHaveBeenCalled();
      release();
    });
  });

  describe('rewindToTurn', () => {
    it('uses the recorded boundary rather than an extra retry snapshot index', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'retry A' }] },
        { role: 'model', parts: [{ text: 'A reply' }] },
        { role: 'user', parts: [{ text: 'B' }] },
      ];
      markApiHistoryPrompt(history[2]!, 'p2');
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(
        ['p1', 'retry-A', 'p2'].map((promptId) => ({
          promptId,
          timestamp: new Date('2026-10-09T00:00:00.000Z'),
          trackedFileBackups: {},
        })),
      );

      expect(session.rewindToTurn(2, { rewindFiles: false })).toEqual({
        targetTurnIndex: 2,
        apiTruncateIndex: 2,
      });
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 1 },
        expect.any(Array),
        { mode: ApprovalMode.DEFAULT },
      );
    });

    function identifyPrompts(history: Content[], indexes: number[]) {
      indexes.forEach((index, ordinal) =>
        markApiHistoryPrompt(history[index]!, `p${ordinal + 1}`),
      );
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(
        indexes.map((_, ordinal) => ({
          promptId: `p${ordinal + 1}`,
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {},
        })),
      );
    }

    it.each([false, true])(
      'keeps ACP rewind available with recording disabled (rewindFiles=%s)',
      (rewindFiles) => {
        const history: Content[] = [
          { role: 'user', parts: [{ text: 'first' }] },
          { role: 'model', parts: [{ text: 'reply' }] },
        ];
        identifyPrompts(history, [0]);
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
        vi.mocked(mockConfig.getChatRecordingService).mockReturnValue(
          undefined,
        );

        expect(session.getRewindCutPoint('p1')).toBe(0);
        expect(session.rewindToTurn(0, { rewindFiles })).toEqual({
          targetTurnIndex: 0,
          apiTruncateIndex: 0,
        });
        expect(mockChat.truncateHistory).toHaveBeenCalledWith(0);
        expect(
          mockFileHistoryService.restoreFromSnapshots,
        ).toHaveBeenCalledWith(
          rewindFiles ? [expect.objectContaining({ promptId: 'p1' })] : [],
        );
        expect(mockChatRecordingService.rewindRecording).not.toHaveBeenCalled();
      },
    );

    it('cuts at the checkpoint identity even when a genuine prompt looks like a notification', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hello response' }] },
        {
          role: 'user',
          parts: [
            {
              text: '<task-notification>literal user-pasted content</task-notification>',
            },
          ],
        },
        { role: 'model', parts: [{ text: 'literal response' }] },
        { role: 'user', parts: [{ text: 'world' }] },
        { role: 'model', parts: [{ text: 'world response' }] },
      ];
      for (const [index, promptId] of [
        [0, 'p1'],
        [2, 'p2'],
        [4, 'p3'],
      ] as const) {
        markApiHistoryPrompt(history[index]!, promptId);
      }
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(
        ['p1', 'p2', 'p3'].map((promptId) => ({
          promptId,
          timestamp: new Date('2026-10-09T00:00:00.000Z'),
          trackedFileBackups: {},
        })),
      );

      expect(session.rewindToTurn(1, { rewindFiles: false })).toEqual({
        targetTurnIndex: 1,
        apiTruncateIndex: 2,
      });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(2);
    });
    it('clears the active-todo chain so a rewound turn starts fresh', async () => {
      // A registered reminder would otherwise make the post-rewind turn
      // continue the rewound-away chain (#10953 regression).
      vi.mocked(mockConfig.getActiveTodoReminder).mockReturnValue(
        '<system-reminder>unfinished todo: delegated node</system-reminder>',
      );
      mockChat.sendMessageStream = vi
        .fn()
        .mockImplementation(async () => createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start work' }],
      });
      expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
        'test-session-id########1',
        undefined,
      );

      const history: Content[] = [
        { role: 'user', parts: [{ text: 'start work' }] },
        { role: 'model', parts: [{ text: 'reply' }] },
      ];
      identifyPrompts(history, [0]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      session.rewindToTurn(0);

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start different work' }],
      });
      expect(mockConfig.startActiveTodoWorkChain).toHaveBeenLastCalledWith(
        'test-session-id########2',
        undefined,
      );
    });

    it('truncates model history before the requested user turn and records rewind', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [0, 2]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(1);

      expect(result).toEqual({ targetTurnIndex: 1, apiTruncateIndex: 2 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(2);
      expect(mockChat.stripThoughtsFromHistory).toHaveBeenCalled();
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 2 },
        expect.arrayContaining([
          expect.objectContaining({ promptId: 'p1' }),
          expect.objectContaining({ promptId: 'p2' }),
        ]),
        { mode: ApprovalMode.DEFAULT },
      );
    });

    it('clears the active Todo plan revision when rewinding', async () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [0, 2]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'old',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'old' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'old-plan' },
          qwenTranscript: { planToolCallId: 'old-call' },
        },
      });
      const bound = await runExitPlanModeApprovalPrompt();
      expect(bound.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'old-plan', sourceCallId: 'old-call' },
        }),
      );

      session.rewindToTurn(1);

      const rewound = await runExitPlanModeApprovalPrompt();
      expect(rewound.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });

    it('can rewind the conversation without restoring file history', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [0, 2]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {},
        },
        {
          promptId: 'p2',
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {},
        },
      ]);

      const result = session.rewindToTurn(1, { rewindFiles: false });

      expect(result).toEqual({ targetTurnIndex: 1, apiTruncateIndex: 2 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(2);
      // One turn survives, so one snapshot may: every rewind surface resolves
      // a turn through this array's positions.
      expect(mockFileHistoryService.restoreFromSnapshots).toHaveBeenCalledWith([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {},
        },
      ]);
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 2 },
        expect.arrayContaining([expect.objectContaining({ promptId: 'p1' })]),
        { mode: ApprovalMode.DEFAULT },
      );
    });

    it('drops snapshot positions along with the turns a rewind discards', () => {
      // A rewind resolves a turn through the snapshot array's POSITION
      // (`getRewindSnapshots` hands out `idx`, the agent resolves a promptId
      // with `findIndex`). Leaving an abandoned turn's snapshot behind makes
      // the position point at a turn the history no longer has, so the next
      // rewind cuts the wrong turn and the recorded branch disagrees with the
      // live view.
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
        { role: 'user', parts: [{ text: 'third' }] },
        { role: 'model', parts: [{ text: 'third reply' }] },
      ];
      identifyPrompts(history, [0, 2, 4]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      const snapshots = ['p1', 'p2', 'p3'].map((promptId) => ({
        promptId,
        timestamp: new Date('2026-06-13T00:00:00.000Z'),
        trackedFileBackups: {},
      }));
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(snapshots);

      session.rewindToTurn(2, { rewindFiles: false });

      // Two turns survive the cut to the third prompt.
      expect(mockFileHistoryService.restoreFromSnapshots).toHaveBeenCalledWith([
        snapshots[0],
        snapshots[1],
      ]);
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        2,
        { truncatedCount: 2 },
        [snapshots[0], snapshots[1]],
        { mode: ApprovalMode.DEFAULT },
      );
    });

    it('preserves startup context when rewinding to the first user turn', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nstartup context\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
      ];
      identifyPrompts(history, [1]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(0);

      expect(result).toEqual({ targetTurnIndex: 0, apiTruncateIndex: 1 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(1);
    });

    it('counts only real user prompts as rewindable turns', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nstartup context\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nNew tools available: foo\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'second' }] },
      ];
      identifyPrompts(history, [1, 4]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.getRewindCutPoint('p2')).toBe(4);
    });

    it('does not count a mid-history MCP added-tool reminder as a user turn', () => {
      // drainPendingAddedMcpToolsReminder injects a pure <system-reminder>
      // user entry mid-history. Counting it as a real turn would land the
      // rewind one entry early, dropping the reminder plus a turn's context.
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nstartup context\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nNew tools available: foo\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [1, 4]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(1);

      // Keep startup + turn 1 + the MCP reminder (indices 0–3); truncate at
      // the second prompt (index 4). Counting the reminder would return 3.
      expect(result).toEqual({ targetTurnIndex: 1, apiTruncateIndex: 4 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(4);
    });

    it('does not count Todo Stop Guard continuations as user turns', () => {
      const guardPrompt =
        '[Todo Stop Guard] 1 todo item(s) are still pending or in progress. Continue executing the current task now. Do not ask the user whether to continue. If progress requires user input, use the structured question or permission flow. If progress depends on external state, report the blocker explicitly.';
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: guardPrompt }] },
        { role: 'model', parts: [{ text: 'guard reply 1' }] },
        {
          role: 'user',
          parts: [
            {
              text: `${guardPrompt} This is the final automatic continuation. Before ending, either complete/update the todos or report the completed progress and the exact blocker.`,
            },
          ],
        },
        { role: 'model', parts: [{ text: 'guard reply 2' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [0, 6]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.rewindToTurn(1)).toEqual({
        targetTurnIndex: 1,
        apiTruncateIndex: 6,
      });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(6);
    });

    it('counts user text that only resembles a Todo Stop Guard prompt', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: '[Todo Stop Guard] 1 todo item(s) are still pending or in progress. Continue executing the current task now. Do not ask the user whether to continue. This is quoted user text.',
            },
          ],
        },
      ];
      identifyPrompts(history, [0]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.getRewindCutPoint('p1')).toBe(0);
    });

    it('counts a marked prompt even when its text is a cleared-media placeholder', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: '[Old inline media cleared: image/png]' }],
        },
      ];
      identifyPrompts(history, [0]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.getRewindCutPoint('p1')).toBe(0);
    });

    it('resolves a cancelled turn whose tool-lap continuation repeats its mark', () => {
      // Cancelling between tool-loop laps pushes the continuation into model
      // history stamped with the turn's own id; the prompt entry must still be
      // the unique anchor instead of turning the whole turn into a refusal.
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          ],
        },
      ];
      markApiHistoryPrompt(history[0]!, 'p1');
      markApiHistoryPrompt(history[2]!, 'p1');
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue([
        {
          promptId: 'p1',
          timestamp: new Date('2026-06-13T00:00:00.000Z'),
          trackedFileBackups: {},
        },
      ]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.getRewindCutPoint('p1')).toBe(0);
    });

    it('does not count a delivered task-notification turn as a rewindable user turn', () => {
      // #9608: a daemon session that ran a background-notification turn
      // carries the turn's `[...systemReminders, ...notificationParts]` user
      // entry in API history. That entry never produced a file-history
      // snapshot (`makeSnapshot` runs on the real prompt path only), so
      // counting it inflates the rewindable count and shifts every rewind
      // cut point after it onto the wrong entry.
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nstartup context\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nNew tools available: foo\n${SYSTEM_REMINDER_CLOSE}`,
            },
            {
              text: '<task-notification>\n<task-id>agent-1</task-id>\n<kind>agent</kind>\n<status>completed</status>\n</task-notification>',
            },
          ],
        },
        { role: 'model', parts: [{ text: 'notification reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      identifyPrompts(history, [1, 5]);
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      // Rewinding to the second real turn must cut at 'second' (index 5);
      // counting the notification entry lands the cut on it (index 3) and
      // drops 'second' plus the notification reply.
      expect(session.rewindToTurn(1)).toEqual({
        targetTurnIndex: 1,
        apiTruncateIndex: 5,
      });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(5);
    });

    it('still counts a real prompt that carries a merged notification part', () => {
      // A mid-turn drain merges queued notification parts into the genuine
      // user message (#takeCurrentTurnBackgroundParts). The mixed entry is a
      // real user turn and must keep its rewind ordinal.
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        {
          role: 'user',
          parts: [
            { text: 'second' },
            {
              text: '<task-notification>\n<task-id>shell-1</task-id>\n<kind>shell</kind>\n<status>completed</status>\n</task-notification>',
            },
          ],
        },
      ];
      identifyPrompts(history, [0, 2]);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(session.getRewindCutPoint('p2')).toBe(2);
    });

    it('resolves a retained checkpoint after compression without renumbering the branch', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nstartup\n${SYSTEM_REMINDER_CLOSE}`,
            },
          ],
        },
        {
          role: 'user',
          parts: [
            { text: '<state_snapshot>summary\n\nResume the prior task...' },
          ],
        },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
        { role: 'user', parts: [{ text: 'third' }] },
      ];
      markApiHistoryPrompt(history[3]!, 'p3');
      mockChatRecordingService.getRewindDaemonPromptId.mockImplementation(
        (id: string) => (id === 'p3' ? 'daemon-C' : undefined),
      );
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(
        ['p1', 'p2', 'p3'].map((promptId) => ({
          promptId,
          timestamp: new Date('2026-10-09T00:00:00.000Z'),
          trackedFileBackups: {},
        })),
      );

      expect(session.rewindToTurn(2, { rewindFiles: false })).toEqual({
        targetTurnIndex: 2,
        apiTruncateIndex: 3,
        daemonPromptId: 'daemon-C',
      });
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        2,
        { truncatedCount: 1 },
        expect.arrayContaining([
          expect.objectContaining({ promptId: 'p1' }),
          expect.objectContaining({ promptId: 'p2' }),
        ]),
        { mode: ApprovalMode.DEFAULT },
      );
    });

    it.each([
      'unmarked',
      'duplicate model id',
      'duplicate snapshot id',
      'legacy snapshot',
      'no snapshots',
      'unlinked recording',
    ])('refuses %s without changing model, snapshots, or recording', (kind) => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'reply' }] },
      ];
      if (kind !== 'unmarked') markApiHistoryPrompt(history[0]!, 'p1');
      if (kind === 'unlinked recording') {
        mockChatRecordingService.getRewindTurnIndex.mockReturnValue(-1);
      }
      if (kind === 'duplicate model id') history.push({ ...history[0]! });
      const snapshots =
        kind === 'no snapshots'
          ? []
          : [kind === 'legacy snapshot' ? 'old-file-key' : 'p1'];
      if (kind === 'duplicate snapshot id') snapshots.push('p1');
      vi.mocked(mockFileHistoryService.getSnapshots).mockReturnValue(
        snapshots.map((promptId) => ({
          promptId,
          timestamp: new Date('2026-10-09T00:00:00.000Z'),
          trackedFileBackups: {},
        })),
      );
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind to the requested turn',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
      expect(
        mockFileHistoryService.restoreFromSnapshots,
      ).not.toHaveBeenCalled();
      expect(mockChatRecordingService.rewindRecording).not.toHaveBeenCalled();
    });

    it('rejects unreachable user turns', () => {
      const history: Content[] = [{ role: 'user', parts: [{ text: 'first' }] }];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      expect(() => session.rewindToTurn(2)).toThrow(
        'Cannot rewind to the requested turn',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects rewinds while a cron prompt is mutating history', () => {
      (session as unknown as { cronProcessing: boolean }).cronProcessing = true;

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects invalid target turn indexes', () => {
      expect(() => session.rewindToTurn(-1)).toThrow(
        'targetTurnIndex must be a non-negative integer',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects rewinds while a prompt is running', () => {
      (session as unknown as { pendingPrompt: AbortController }).pendingPrompt =
        new AbortController();

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects history mutation until an aborted prompt actually settles', () => {
      (
        session as unknown as {
          pendingPromptCompletion: Promise<void> | null;
        }
      ).pendingPromptCompletion = new Promise<void>(() => {});

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });

    it('rejects history mutation while close is in progress', () => {
      const releaseClose = session.beginClose();

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      releaseClose();
    });

    it('rejects rewinds while a cron abort is active', () => {
      (
        session as unknown as { cronAbortController: AbortController }
      ).cronAbortController = new AbortController();

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects rewinds while a notification prompt is processing', () => {
      (
        session as unknown as { notificationProcessing: boolean }
      ).notificationProcessing = true;

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it('rejects rewinds while a notification abort controller is active', () => {
      (
        session as unknown as { notificationAbortController: AbortController }
      ).notificationAbortController = new AbortController();

      expect(() => session.rewindToTurn(0)).toThrow(
        'Cannot rewind while a prompt is running',
      );
      expect(mockChat.truncateHistory).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'preserves compressed context boundaries across edit rollback JSON (startup: %s)',
      (startup) => {
        const history: Content[] = [
          ...(startup
            ? [
                {
                  role: 'user',
                  parts: [
                    { text: '<system-reminder>\nStartup\n</system-reminder>' },
                  ],
                },
              ]
            : []),
          {
            role: 'user',
            parts: [{ text: 'Summary. Resume the prior task...' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Got it. Thanks for the additional context!' }],
          },
        ];
        markCompressedHistory(history);
        const input: Content = {
          role: 'user',
          parts: [
            {
              text: 'Recently accessed file (full current content embedded):\n\n## /tmp/a.ts\n\n```\nconst a = 1;\n```',
            },
          ],
        };
        history.push(input);
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
        const snapshot = session.captureHistorySnapshot();
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue(
          history.slice(0, -1),
        );
        session.restoreHistory(JSON.parse(JSON.stringify(snapshot)));
        const restored = vi.mocked(mockChat.setHistory).mock.calls.at(-1)![0];
        expect(detectTurnInterruption(restored)).toEqual({
          kind: 'interrupted_prompt',
          parts: input.parts,
        });
        expect(JSON.stringify(restored)).toBe(JSON.stringify(snapshot));

        const older: Content[] = JSON.parse(JSON.stringify(history));
        older[older.length - 1] = {
          role: 'user',
          parts: [{ text: 'Real input.' }],
        };
        // A later capture detects the attachment shape as a longer prefix.
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue(
          JSON.parse(JSON.stringify(history)),
        );
        session.captureHistorySnapshot();
        session.restoreHistory(older);
        expect(
          getStartupContextLength(
            vi.mocked(mockChat.setHistory).mock.calls.at(-1)![0],
            { includeCompressed: true },
          ),
        ).toBe(startup ? 3 : 2);
      },
    );

    it('preserves a compressed boundary across mixed legacy and bound prompt echoes', () => {
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Summary. Resume the prior task...' }],
        },
        {
          role: 'model',
          parts: [{ text: 'Got it. Thanks for the additional context!' }],
        },
      ];
      markCompressedHistory(history);
      history.push(
        {
          role: 'user',
          parts: [
            {
              text: 'Recently accessed file (full current content embedded):\n\n## /tmp/a.ts\n\n```\nconst a = 1;\n```',
            },
          ],
        },
        { role: 'model', parts: [{ text: 'Legacy reply.' }] },
      );
      const fresh: Content = { role: 'user', parts: [{ text: 'Fresh task.' }] };
      markApiHistoryPrompt(fresh, 'p1');
      history.push(fresh);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
      const snapshot = session.captureHistorySnapshot();
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(
        history.slice(0, 2),
      );
      session.restoreHistory(
        JSON.parse(
          JSON.stringify(
            snapshot.map((content) => ({
              ...content,
              rewindId: getApiHistoryPromptId(content),
            })),
          ),
        ),
      );
      const restored = vi.mocked(mockChat.setHistory).mock.calls.at(-1)![0];
      expect(
        getStartupContextLength(restored, { includeCompressed: true }),
      ).toBe(2);
      expect(getApiHistoryPromptId(restored.at(-1)!)).toBe('p1');
    });

    it.each(['in-process', 'JSON roundtrip'])(
      'restores a captured history snapshot through %s',
      (transport) => {
        const history: Content[] = [
          { role: 'user', parts: [{ text: 'first' }] },
          { role: 'model', parts: [{ text: 'first reply' }] },
        ];
        markApiHistoryPrompt(history[0]!, 'p1');
        vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

        const snapshot = session.captureHistorySnapshot();
        const incoming =
          transport === 'in-process'
            ? snapshot
            : JSON.parse(
                JSON.stringify(
                  snapshot.map((content) => ({
                    ...content,
                    rewindId: getApiHistoryPromptId(content),
                  })),
                ),
              );
        session.restoreHistory(incoming);

        expect(snapshot).toEqual(history);
        const restored = vi.mocked(mockChat.setHistory).mock.calls[0]![0];
        expect(restored).toEqual(history);
        expect(restored[0]).not.toBe(history[0]);
        expect(restored[0]!.parts).not.toBe(history[0]!.parts);
        expect(getApiHistoryPromptId(restored[0]!)).toBe('p1');
        expect(restored[0]).not.toHaveProperty('rewindId');
        expect(mockChat.getHistory).not.toHaveBeenCalled();
      },
    );

    it('clears the active Todo plan revision when restoring history', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'old',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'old' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'old-plan' },
          qwenTranscript: { planToolCallId: 'old-call' },
        },
      });
      const bound = await runExitPlanModeApprovalPrompt();
      expect(bound.toolCall._meta).toEqual(
        expect.objectContaining({
          qwenTodoApproval: { planId: 'old-plan', sourceCallId: 'old-call' },
        }),
      );

      session.restoreHistory([]);

      const restored = await runExitPlanModeApprovalPrompt();
      expect(restored.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });

    it('rejects history restore while a prompt is running', () => {
      (session as unknown as { pendingPrompt: AbortController }).pendingPrompt =
        new AbortController();

      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });

    it('rejects history restore while a cron prompt is mutating history', () => {
      (session as unknown as { cronProcessing: boolean }).cronProcessing = true;

      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });

    it('rejects history restore while a cron abort is active', () => {
      (
        session as unknown as { cronAbortController: AbortController }
      ).cronAbortController = new AbortController();

      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });

    it('rejects history restore while a notification prompt is processing', () => {
      (
        session as unknown as { notificationProcessing: boolean }
      ).notificationProcessing = true;

      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });

    it('rejects history restore while a notification abort controller is active', () => {
      (
        session as unknown as { notificationAbortController: AbortController }
      ).notificationAbortController = new AbortController();

      expect(() => session.restoreHistory([])).toThrow(
        'Cannot restore history while a prompt is running',
      );
      expect(mockChat.setHistory).not.toHaveBeenCalled();
    });
  });

  describe('setModel', () => {
    function installReasoningPreference(
      selection: 'none' | 'low' | 'max',
      options: {
        trusted?: boolean;
        thinkingMandatory?: boolean;
        defaultReasoning?: ContentGeneratorConfig['reasoning'];
      } = {},
    ) {
      type ReasoningSettingsLayer = {
        settings: { model: { reasoningEffort?: typeof selection } };
        originalSettings: { model: { reasoningEffort?: typeof selection } };
      };
      const user: ReasoningSettingsLayer = {
        settings: { model: { reasoningEffort: selection } },
        originalSettings: { model: { reasoningEffort: selection } },
      };
      const workspace = structuredClone(user);
      const live: Partial<ContentGeneratorConfig> & { model: string } = {
        model: currentModel,
        ...(options.thinkingMandatory ? { thinkingMandatory: true } : {}),
        reasoning: selection === 'none' ? false : { effort: selection },
      };
      const rebuildable: Partial<ContentGeneratorConfig> =
        structuredClone(live);
      Object.assign(mockSettings, {
        isTrusted: options.trusted === true,
        user,
        workspace,
        forScope: vi.fn((scope: SettingScope) =>
          scope === SettingScope.Workspace ? workspace : user,
        ),
        merged: { model: { reasoningEffort: selection } },
        recomputeMerged: vi.fn(() => {
          const value =
            (options.trusted
              ? workspace.settings.model.reasoningEffort
              : undefined) ?? user.settings.model.reasoningEffort;
          mockSettings.merged.model =
            value === undefined ? {} : { reasoningEffort: value };
        }),
      });
      vi.mocked(mockSettings.setValue).mockImplementation(
        (scope, key, value) => {
          if (key !== 'model.reasoningEffort') return;
          const target = scope === SettingScope.Workspace ? workspace : user;
          target.settings.model.reasoningEffort = value as
            | typeof selection
            | undefined;
          target.originalSettings.model.reasoningEffort = value as
            | typeof selection
            | undefined;
          mockSettings.recomputeMerged();
        },
      );
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue(
        live as ReturnType<Config['getContentGeneratorConfig']>,
      );
      Object.assign(mockConfig, {
        getModelsConfig: vi.fn(() => ({
          getGenerationConfig: () => rebuildable,
        })),
        getResolvedModelConfig: vi.fn(() => ({
          generationConfig: { reasoning: options.defaultReasoning },
        })),
      });
      switchModelSpy.mockImplementation(
        async (authType: AuthType, modelId: string) => {
          currentAuthType = authType;
          currentModel = modelId;
          live.model = modelId;
          rebuildable.model = modelId;
          live.reasoning = options.defaultReasoning;
          rebuildable.reasoning = options.defaultReasoning;
        },
      );
      return { user, workspace, live, rebuildable };
    }

    it('sets model via config and returns current model', async () => {
      const requested = `qwen3-coder-plus(${AuthType.USE_OPENAI})`;
      vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue([
        {
          id: 'qwen3-coder-plus',
          label: 'Qwen3 Coder Plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://default.example/v1',
        },
      ]);
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `  ${requested}  `,
      });

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-coder-plus',
        undefined,
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.name',
        'qwen3-coder-plus',
      );
      // Id-only switch must clear any stale baseUrl disambiguator (tombstone).
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.baseUrl',
        '',
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.USE_OPENAI,
      );
      expect(mockChatRecordingService.recordSessionModel).toHaveBeenCalledWith({
        modelId: 'qwen3-coder-plus',
        authType: AuthType.USE_OPENAI,
      });
    });

    it.each([
      ['configured Responses', ['responses'], AuthType.USE_OPENAI],
      ['configured Chat', ['chat-completions'], AuthType.USE_OPENAI],
      ['raw', [], AuthType.USE_OPENAI_RESPONSES],
      ['runtime', ['responses'], AuthType.USE_OPENAI_RESPONSES],
      [
        'duplicate Responses',
        ['chat-completions', 'responses'],
        AuthType.USE_OPENAI_RESPONSES,
      ],
      [
        'duplicate Chat',
        ['chat-completions', 'responses'],
        AuthType.USE_OPENAI,
      ],
      ['Workspace', ['responses'], AuthType.USE_OPENAI_RESPONSES],
      ['inherited Workspace', ['responses'], AuthType.USE_OPENAI],
      [
        'invalid reload',
        ['responses', 'invalid'],
        AuthType.USE_OPENAI_RESPONSES,
      ],
    ] as const)(
      'persists the auth choice for %s',
      async (scenario, wires, expectedAuth) => {
        const modelId = 'gpt-6-astra';
        const baseUrl = 'https://api.example/v1';
        const isChat = scenario.endsWith('Chat');
        const authType = isChat
          ? AuthType.USE_OPENAI
          : AuthType.USE_OPENAI_RESPONSES;
        const scope = scenario.endsWith('Workspace')
          ? SettingScope.Workspace
          : SettingScope.User;
        const owner =
          scope === SettingScope.Workspace
            ? mockSettings.workspace
            : mockSettings.user;
        Object.assign(mockSettings, {
          isTrusted: scope === SettingScope.Workspace,
        });
        mockSettings.user.settings.security = {
          auth: { selectedType: AuthType.USE_OPENAI },
        };
        owner.settings.security = {
          auth: {
            selectedType:
              scenario === 'Workspace' || isChat
                ? AuthType.USE_OPENAI_RESPONSES
                : AuthType.USE_OPENAI,
          },
        };
        if (scenario === 'inherited Workspace') {
          delete owner.settings.security;
          mockSettings.merged.security = mockSettings.user.settings.security;
        }
        owner.settings.modelProviders = {
          openai: wires.map((wireApi) => ({
            id: wireApi === 'invalid' ? 'broken' : modelId,
            baseUrl,
            wireApi: wireApi as ProviderModelConfig['wireApi'],
          })),
        };
        mockSettings.merged.modelProviders = owner.settings.modelProviders;
        const models = wires
          .filter((wire) => wire !== 'invalid')
          .map((wire) => ({
            id: modelId,
            label: wire,
            authType:
              wire === 'responses'
                ? AuthType.USE_OPENAI_RESPONSES
                : AuthType.USE_OPENAI,
            baseUrl,
            registryBaseUrl: baseUrl,
          }));
        vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType,
          model: modelId,
        } as ReturnType<Config['getContentGeneratorConfig']>);
        const snapshotId = `$runtime|${authType}|${modelId}`;
        const selectedId =
          scenario === 'runtime'
            ? `${snapshotId}(${authType})`
            : (buildAcpModelOptions(models).find(
                (option) => option.model.authType === authType,
              )?.modelId ?? `${modelId}(${authType})`);

        await session.setModel({
          sessionId: 'test-session-id',
          modelId: selectedId,
        });

        expect(
          vi
            .mocked(mockSettings.setValue)
            .mock.calls.filter(
              ([, key]) => key === 'security.auth.selectedType',
            ),
        ).toEqual([[scope, 'security.auth.selectedType', expectedAuth]]);
        expect(mockConfig.switchModel).toHaveBeenCalledWith(
          authType,
          scenario === 'runtime' ? snapshotId : modelId,
          scenario === 'raw' || scenario === 'runtime'
            ? undefined
            : { baseUrl },
        );
        expect(
          mockChatRecordingService.recordSessionModel,
        ).toHaveBeenCalledWith(expect.objectContaining({ authType }));
      },
    );

    it.each([
      {
        scenario: 'a workspace-only auth choice',
        selectedType: undefined,
        wires: ['responses'],
      },
      {
        scenario: 'the same id at endpoints with different wires',
        selectedType: AuthType.USE_OPENAI,
        wires: ['responses', 'chat-completions'],
      },
    ] as const)(
      'keeps the effective auth for $scenario',
      async ({ selectedType, wires }) => {
        const providers = wires.map((wireApi) => ({
          id: 'shared-model',
          baseUrl: `https://${wireApi}.example/v1`,
          wireApi,
        }));
        mockSettings.user.settings = {
          security: { auth: { selectedType } },
          modelProviders: { openai: providers },
        };
        mockSettings.workspace.settings = {
          security: { auth: { selectedType: AuthType.USE_OPENAI } },
        };
        Object.assign(mockSettings, {
          isTrusted: true,
          merged: {
            ...mockSettings.user.settings,
            security: mockSettings.workspace.settings.security,
          },
        });
        const models = providers.map(({ wireApi, ...model }) => ({
          ...model,
          label: wireApi,
          registryBaseUrl: model.baseUrl,
          authType:
            wireApi === 'responses'
              ? AuthType.USE_OPENAI_RESPONSES
              : AuthType.USE_OPENAI,
        }));
        vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
        const target = buildAcpModelOptions(models).find(
          (option) => option.model.authType === AuthType.USE_OPENAI_RESPONSES,
        )!;

        await session.setModel({
          sessionId: 'test-session-id',
          modelId: target.modelId,
        });

        expect(
          vi
            .mocked(mockSettings.setValue)
            .mock.calls.filter(
              ([, key]) => key === 'security.auth.selectedType',
            ),
        ).toEqual([
          [
            SettingScope.User,
            'security.auth.selectedType',
            AuthType.USE_OPENAI_RESPONSES,
          ],
        ]);
        expect(mockSettings.setValue).toHaveBeenCalledWith(
          SettingScope.User,
          'model.baseUrl',
          'https://responses.example/v1',
        );
      },
    );

    it('persists a runtime-snapshot switch with the isRuntime payload flag', async () => {
      const snapshotId = `$runtime|${AuthType.USE_OPENAI}|custom-runtime`;
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `${snapshotId}(${AuthType.USE_OPENAI})`,
      });

      expect(mockChatRecordingService.recordSessionModel).toHaveBeenCalledWith({
        modelId: snapshotId,
        authType: AuthType.USE_OPENAI,
        isRuntime: true,
      });
    });

    it('emits a current_model_update extNotification after switching (A1)', async () => {
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `qwen3-coder-plus(${AuthType.USE_OPENAI})`,
      });

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/model-update',
        expect.objectContaining({
          v: 1,
          sessionId: 'test-session-id',
          currentModelId: `qwen3-coder-plus(${AuthType.USE_OPENAI})`,
        }),
      );
    });

    it('resolves an opaque ACP route and persists the canonical model identity', async () => {
      const models = [
        {
          id: 'shared-model',
          label: 'Provider One',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://one.example/v1',
          registryBaseUrl: 'https://one.example/v1',
        },
        {
          id: 'shared-model',
          label: 'Provider Two',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://two.example/v1',
          registryBaseUrl: 'https://two.example/v1',
        },
      ];
      let activeBaseUrl = 'https://one.example/v1';
      vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
      vi.mocked(mockConfig.getContentGeneratorConfig).mockImplementation(
        () =>
          ({
            authType: currentAuthType,
            model: currentModel,
            baseUrl: activeBaseUrl,
          }) as ReturnType<Config['getContentGeneratorConfig']>,
      );
      switchModelSpy.mockImplementation(
        async (
          authType: AuthType,
          modelId: string,
          options?: { baseUrl?: string },
        ) => {
          currentAuthType = authType;
          currentModel = modelId;
          activeBaseUrl = options?.baseUrl ?? activeBaseUrl;
        },
      );
      const routeId = buildAcpModelOptions(models)[1]!.modelId;

      const response = await session.setModel({
        sessionId: 'test-session-id',
        modelId: routeId,
      });

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'shared-model',
        { baseUrl: 'https://two.example/v1' },
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.name',
        'shared-model',
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.baseUrl',
        'https://two.example/v1',
      );
      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/model-update',
        expect.objectContaining({ currentModelId: routeId }),
      );
      expect(response).toMatchObject({
        _meta: {
          qwenModelSwitch: {
            modelId: 'shared-model',
            baseUrl: 'https://two.example/v1',
          },
        },
      });
      expect(mockChatRecordingService.recordSessionModel).toHaveBeenCalledWith({
        modelId: 'shared-model',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://two.example/v1',
      });
    });

    it('switches an implicit route without using its resolved default as a registry key', async () => {
      const models = [
        {
          id: 'shared-model',
          label: 'Implicit Default',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://default.example/v1',
        },
        {
          id: 'shared-model',
          label: 'Explicit Route',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://default.example/v1',
          registryBaseUrl: 'https://default.example/v1',
        },
      ];
      vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
      const routeId = buildAcpModelOptions(models)[0]!.modelId;

      const response = await session.setModel({
        sessionId: 'test-session-id',
        modelId: routeId,
      });

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'shared-model',
        undefined,
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.name',
        'shared-model',
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.baseUrl',
        '',
      );
      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/model-update',
        expect.objectContaining({ currentModelId: routeId }),
      );
      expect(response).toMatchObject({
        _meta: {
          qwenModelSwitch: {
            modelId: 'shared-model',
          },
        },
      });
    });

    it('does NOT emit the model-update notification when the switch fails (A1)', async () => {
      switchModelSpy.mockRejectedValueOnce(new Error('switch boom'));
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: `qwen3-coder-plus(${AuthType.USE_OPENAI})`,
        }),
      ).rejects.toThrow();
      expect(mockClient.extNotification).not.toHaveBeenCalledWith(
        'qwen/notify/session/model-update',
        expect.anything(),
      );
    });

    it.each([
      "Model 'qwen-typo' not found for authType 'openai'",
      "Model 'qwen\ntypo' not found for authType 'openai'",
      "Image-only model 'qwen-image' cannot be used as the primary model",
      "Voice-only model 'qwen-voice' cannot be used as the primary model",
      "Realtime-only model 'qwen-realtime' cannot be used as the primary model",
    ])(
      'maps the caller-caused switchModel refusal to invalid params: %s',
      async (message) => {
        switchModelSpy.mockRejectedValueOnce(new Error(message));
        const rejection: unknown = await session
          .setModel({
            sessionId: 'test-session-id',
            modelId: `qwen-typo(${AuthType.USE_OPENAI})`,
          })
          .then(
            () => {
              throw new Error('expected setModel to reject');
            },
            (error: unknown) => error,
          );
        expect(rejection).toBeInstanceOf(RequestError);
        expect((rejection as RequestError).code).toBe(-32602);
        expect((rejection as Error).message).toBe(`Invalid params: ${message}`);
        expect(mockSettings.setValue).not.toHaveBeenCalled();
      },
    );

    it('maps the refusal core actually throws, not a hand-written copy of its message', async () => {
      // The classifier matches core's human-readable switchModel messages;
      // driving the real ModelsConfig keeps that string contract honest — a
      // reworded core message turns this red instead of silently degrading
      // the definite caller rejection into an internal error.
      const realModels = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            { id: 'chat-model' },
            { id: 'image-model', imageOnly: true },
          ],
        },
      });
      switchModelSpy.mockImplementation((authType: AuthType, modelId: string) =>
        realModels.switchModel(authType, modelId),
      );

      for (const modelId of ['qwen-typo', 'image-model']) {
        const rejection: unknown = await session
          .setModel({
            sessionId: 'test-session-id',
            modelId: `${modelId}(${AuthType.USE_OPENAI})`,
          })
          .then(
            () => {
              throw new Error('expected setModel to reject');
            },
            (error: unknown) => error,
          );
        expect(rejection).toBeInstanceOf(RequestError);
        expect((rejection as RequestError).code).toBe(-32602);
      }
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });

    it('keeps daemon-side switchModel faults as internal errors', async () => {
      const fault = new Error(
        "Missing API key for openai auth. Current model: 'gpt-5.4'.",
      );
      switchModelSpy.mockRejectedValueOnce(fault);
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: `gpt-5.4(${AuthType.USE_OPENAI})`,
        }),
      ).rejects.toBe(fault);
    });

    it('rejects empty/whitespace model IDs', async () => {
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: '   ',
        }),
      ).rejects.toThrow('Invalid params');

      expect(mockConfig.switchModel).not.toHaveBeenCalled();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });

    it('rejects an opaque route that is no longer advertised', async () => {
      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: 'qwen-route:v1:abcdefghijklmnop',
        }),
      ).rejects.toThrow('Unknown or stale model route');

      expect(mockConfig.switchModel).not.toHaveBeenCalled();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });

    it('can switch the session model without persisting a new default', async () => {
      await session.setModel(
        {
          sessionId: 'test-session-id',
          modelId: `qwen3-coder-flash(${AuthType.USE_OPENAI})`,
        },
        { persistDefault: false },
      );

      expect(mockConfig.switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-coder-flash',
        undefined,
      );
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordSessionModel).toHaveBeenCalledWith({
        modelId: 'qwen3-coder-flash',
        authType: AuthType.USE_OPENAI,
      });
    });

    it('clears only the live override for a non-persisting ACP model switch', async () => {
      const state = installReasoningPreference('max');

      await session.setModel(
        {
          sessionId: 'test-session-id',
          modelId: `qwen3.8-max(${AuthType.USE_OPENAI})`,
        },
        { persistDefault: false },
      );

      expect(state.user.settings.model.reasoningEffort).toBe('max');
      expect(state.live.reasoning).toBeUndefined();
      expect(state.rebuildable.reasoning).toBeUndefined();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });

    it.each(['max', 'none'] as const)(
      'preserves global GPT %s across model switches and reloads',
      async (selection) => {
        const state = installReasoningPreference(selection, { trusted: true });
        const modelId = selection === 'max' ? 'gpt-5.4' : 'gpt-6-astra';
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: `${modelId}(${AuthType.USE_OPENAI})`,
        });
        session.reloadReasoningSelection();
        expect(state.user.settings.model.reasoningEffort).toBe(selection);
        expect(state.workspace.settings.model.reasoningEffort).toBe(selection);
        expect(state.live.reasoning).toEqual(
          selection === 'max' ? { effort: 'max' } : undefined,
        );
        expect(state.rebuildable.reasoning).toEqual(state.live.reasoning);
        expect(
          vi
            .mocked(mockSettings.setValue)
            .mock.calls.filter((call) => call[1] === 'model.reasoningEffort'),
        ).toEqual([]);
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: `gpt-5.6-sol(${AuthType.USE_OPENAI})`,
        });
        expect(state.live.reasoning).toEqual(
          selection === 'max' ? { effort: 'max' } : false,
        );
        expect(state.rebuildable.reasoning).toEqual(state.live.reasoning);
      },
    );

    it.each([
      ['gpt-6-astra', false, undefined],
      ['gpt-6-astra', true, undefined],
      ['gpt-5', false, undefined],
      ['gpt-6-astra', false, false],
    ] as const)(
      'reconciles saved off for %s with configured toggleOnly=%s, canDisable=%s',
      async (modelId, toggleOnly, canDisable) => {
        const state = installReasoningPreference('none', { trusted: true });
        Object.assign(mockConfig, {
          getResolvedModelConfig: vi.fn(() => ({
            generationConfig: {},
            capabilities: {
              reasoning: {
                thinking: true,
                ...(toggleOnly
                  ? { toggleOnly: true }
                  : { efforts: ['low', 'high'], defaultEffort: 'high' }),
                disableField: 'reasoning_effort',
                ...(canDisable === false ? { canDisable } : {}),
              },
            },
          })),
        });
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: `${modelId}(${AuthType.USE_OPENAI})`,
        });
        session.reloadReasoningSelection();
        for (const scope of [state.user, state.workspace]) {
          for (const settings of [scope.settings, scope.originalSettings]) {
            expect(settings.model).toEqual(
              canDisable === false ? {} : { reasoningEffort: 'none' },
            );
          }
        }
        expect(state.live.reasoning).toBeUndefined();
        expect(state.rebuildable.reasoning).toBeUndefined();
        expect(
          vi
            .mocked(mockSettings.setValue)
            .mock.calls.filter((call) => call[1] === 'model.reasoningEffort'),
        ).toHaveLength(canDisable === false ? 2 : 0);
      },
    );

    it('reconciles a GPT preference against explicit configured capabilities', async () => {
      const state = installReasoningPreference('max', { trusted: true });
      Object.assign(mockConfig, {
        getResolvedModelConfig: vi.fn(() => ({
          generationConfig: {},
          capabilities: {
            reasoning: {
              thinking: true,
              efforts: ['low', 'high'],
              defaultEffort: 'high',
              disableField: 'reasoning_effort',
            },
          },
        })),
      });
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `gpt-5.6-sol(${AuthType.USE_OPENAI})`,
      });
      expect(state.user.settings.model).not.toHaveProperty('reasoningEffort');
      expect(state.workspace.settings.model).not.toHaveProperty(
        'reasoningEffort',
      );
      expect(state.live.reasoning).toBeUndefined();
      expect(state.rebuildable.reasoning).toBeUndefined();
    });

    it('deletes an incompatible max preference from both writable scopes without downgrading it', async () => {
      const state = installReasoningPreference('max', { trusted: true });

      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `qwen3.8-max(${AuthType.USE_OPENAI})`,
      });

      expect(state.user.settings.model).not.toHaveProperty('reasoningEffort');
      expect(state.workspace.settings.model).not.toHaveProperty(
        'reasoningEffort',
      );
      expect(state.live.reasoning).toBeUndefined();
      expect(state.rebuildable.reasoning).toBeUndefined();
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.Workspace,
        'model.reasoningEffort',
        undefined,
        undefined,
        { throwOnWriteFailure: true },
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.reasoningEffort',
        undefined,
        undefined,
        { throwOnWriteFailure: true },
      );
      expect(mockSettings.setValue).not.toHaveBeenCalledWith(
        expect.anything(),
        'model.reasoningEffort',
        'xhigh',
        expect.anything(),
        expect.anything(),
      );

      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `claude-opus-4-6(${AuthType.USE_OPENAI})`,
      });
      expect(state.live.reasoning).toBeUndefined();
    });

    it.each([
      ['low', 'qwen3.8-max', {}, { effort: 'low' }, 'low'],
      ['none', 'qwen3.7-plus', {}, false, 'none'],
      [
        'low',
        'qwen3.8-max',
        { defaultReasoning: false },
        { effort: 'low' },
        'low',
      ],
      [
        'low',
        'qwen3.8-max',
        { defaultReasoning: { budget_tokens: 42000 } },
        { effort: 'low', budget_tokens: 42000 },
        'low',
      ],
      ['max', 'qwen3.7-plus', { defaultReasoning: false }, false, undefined],
      ['max', 'qwen3.7-plus', {}, undefined, undefined],
      ['none', 'qwen-plus', {}, undefined, undefined],
      [
        'none',
        'qwen3.8-max',
        { thinkingMandatory: true },
        undefined,
        undefined,
      ],
    ] as const)(
      'reconciles reasoning %s for %s with %j',
      async (selection, modelId, options, expected, stored) => {
        const state = installReasoningPreference(selection, options);
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: `${modelId}(${AuthType.USE_OPENAI})`,
        });

        expect(state.live.reasoning).toEqual(expected);
        expect(state.rebuildable.reasoning).toEqual(expected);
        expect(state.user.settings.model).toStrictEqual(
          stored === undefined ? {} : { reasoningEffort: stored },
        );
        if (stored !== undefined) {
          expect(mockSettings.setValue).not.toHaveBeenCalledWith(
            expect.anything(),
            'model.reasoningEffort',
            undefined,
            expect.anything(),
            expect.anything(),
          );
        }
        if ('defaultReasoning' in options) {
          expect(session.getDefaultReasoningConfig()).toEqual(
            options.defaultReasoning,
          );
        }
      },
    );

    it.each(['low', 'none'] as const)(
      'reconciles persisted %s across official and MaaS routes of the same DeepSeek model',
      async (selection) => {
        const official = 'https://api.deepseek.com/v1';
        const maas = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
        const models = [official, maas].map((baseUrl) => ({
          id: 'deepseek-v4-pro',
          label: baseUrl,
          authType: AuthType.USE_OPENAI,
          baseUrl,
          registryBaseUrl: baseUrl,
        }));
        vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
        const state = installReasoningPreference(selection);
        Object.assign(state.live, {
          authType: AuthType.USE_OPENAI,
          baseUrl: official,
        });
        Object.assign(state.rebuildable, state.live);
        switchModelSpy.mockImplementation(async (authType, modelId, route) => {
          currentAuthType = authType;
          currentModel = modelId;
          Object.assign(state.live, {
            model: modelId,
            authType,
            baseUrl: route?.baseUrl,
            reasoning: undefined,
          });
          Object.assign(state.rebuildable, state.live);
        });
        const routes = buildAcpModelOptions(models);
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: routes[0]!.modelId,
        });
        expect(state.live.reasoning).toEqual(
          selection === 'none' ? false : { effort: 'low' },
        );
        expect(state.user.settings.model.reasoningEffort).toBe(selection);

        await session.setModel({
          sessionId: 'test-session-id',
          modelId: routes[1]!.modelId,
        });
        const expected = selection === 'none' ? false : undefined;
        expect(state.live.reasoning).toEqual(expected);
        expect(state.rebuildable.reasoning).toEqual(expected);
        expect(state.user.settings.model.reasoningEffort).toBe(
          selection === 'none' ? 'none' : undefined,
        );
      },
    );

    it.each(['low', 'max'] as const)(
      'reconciles persisted %s against the final DeepSeek model on reload',
      (selection) => {
        const state = installReasoningPreference(selection);
        currentModel = 'deepseek-v4.1-flash-1017';
        Object.assign(state.live, {
          model: currentModel,
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          extra_body: { model: 'deepseek-v4-pro' },
        });
        Object.assign(state.rebuildable, state.live);
        session.reloadReasoningSelection();
        expect(state.live.reasoning).toEqual(
          selection === 'max' ? { effort: 'max' } : undefined,
        );
        expect(state.rebuildable.reasoning).toEqual(state.live.reasoning);
        expect(state.user.settings.model.reasoningEffort).toBe(
          selection === 'max' ? 'max' : undefined,
        );
        expect(state.live.extra_body).toEqual({ model: 'deepseek-v4-pro' });
      },
    );

    it('falls back to a compatible persisted tier after dropping a session-only tier', async () => {
      const state = installReasoningPreference('low');
      session.setSessionReasoningSelection('max');

      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `qwen3.8-max(${AuthType.USE_OPENAI})`,
      });

      expect(state.live.reasoning).toEqual({ effort: 'low' });
      expect(state.rebuildable.reasoning).toEqual({ effort: 'low' });
      expect(state.user.settings.model.reasoningEffort).toBe('low');
    });

    it.each([
      ['low', { effort: 'low' }, true],
      ['none', false, true],
      ['default', undefined, false],
    ] as const)(
      'reconciles session-only reasoning %s after a model rebuild',
      async (selection, expectedReasoning, clearsOverrides) => {
        const samplingParams = {
          enable_thinking: false,
          temperature: 0.2,
        };
        const live: Partial<ContentGeneratorConfig> & { model: string } = {
          model: currentModel,
          reasoning:
            selection === 'none'
              ? false
              : selection === 'default'
                ? undefined
                : { effort: selection },
        };
        const rebuildable: Partial<ContentGeneratorConfig> = {};
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue(
          live as ReturnType<Config['getContentGeneratorConfig']>,
        );
        Object.assign(mockConfig, {
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: () => rebuildable,
          })),
        });
        session.setSessionReasoningSelection(selection);
        switchModelSpy.mockImplementation(async (authType, nextModelId) => {
          currentAuthType = authType;
          currentModel = nextModelId;
          Object.assign(live, {
            model: nextModelId,
            reasoning: undefined,
            samplingParams,
          });
          Object.assign(rebuildable, {
            model: nextModelId,
            reasoning: undefined,
            samplingParams,
          });
        });

        await session.setModel({
          sessionId: 'test-session-id',
          modelId: `qwen3.8-max(${AuthType.USE_OPENAI})`,
        });

        expect(live.reasoning).toEqual(expectedReasoning);
        expect(live.samplingParams).toEqual(
          clearsOverrides ? { temperature: 0.2 } : samplingParams,
        );
        expect(rebuildable.samplingParams).toEqual(samplingParams);
        expect(mockSettings.setValue).not.toHaveBeenCalledWith(
          expect.anything(),
          'model.reasoningEffort',
          expect.anything(),
          expect.anything(),
          expect.anything(),
        );
      },
    );

    it('retains a compatible preference when switching to a runtime snapshot', async () => {
      const state = installReasoningPreference('low');
      const snapshotId = `$runtime|${AuthType.USE_OPENAI}|qwen3.8-max`;
      Object.assign(mockConfig, {
        getActiveRuntimeModelSnapshot: vi.fn(() => ({
          id: snapshotId,
          modelId: 'qwen3.8-max',
          authType: AuthType.USE_OPENAI,
        })),
      });
      switchModelSpy.mockImplementationOnce(async () => {
        currentModel = 'qwen3.8-max';
        state.live.model = currentModel;
        state.live.reasoning = undefined;
        state.rebuildable.reasoning = undefined;
      });
      await session.setModel({
        sessionId: 'test-session-id',
        modelId: `${snapshotId}(${AuthType.USE_OPENAI})`,
      });
      expect(state.user.settings.model.reasoningEffort).toBe('low');
      expect(state.live.reasoning).toEqual({ effort: 'low' });
      expect(state.rebuildable.reasoning).toEqual({ effort: 'low' });
    });

    it.each(['low', 'none'] as const)(
      'retains compatible %s on an opaque route using the resolved base model',
      async (selection) => {
        const state = installReasoningPreference(selection);
        const models = ['one', 'two'].map((name) => ({
          id: 'qwen3.8-max',
          label: name,
          authType: AuthType.USE_OPENAI,
          baseUrl: `https://${name}.example/v1`,
          registryBaseUrl: `https://${name}.example/v1`,
        }));
        vi.mocked(mockConfig.getAllConfiguredModels).mockReturnValue(models);
        await session.setModel({
          sessionId: 'test-session-id',
          modelId: buildAcpModelOptions(models)[1]!.modelId,
        });
        expect(mockConfig.switchModel).toHaveBeenCalledWith(
          AuthType.USE_OPENAI,
          'qwen3.8-max',
          { baseUrl: 'https://two.example/v1' },
        );
        expect(state.user.settings.model.reasoningEffort).toBe(selection);
        expect(state.live.reasoning).toEqual(
          selection === 'none' ? false : { effort: selection },
        );
      },
    );

    it('does not treat a runtime snapshot of a previous selection as the model default', () => {
      installReasoningPreference('none');
      Object.assign(mockConfig, {
        getActiveRuntimeModelSnapshot: vi.fn(() => ({
          generationConfig: { reasoning: { effort: 'max' } },
        })),
      });
      Object.assign(mockSettings.merged.model!, {
        generationConfig: { reasoning: { budget_tokens: 42000 } },
      });
      expect(session.getDefaultReasoningConfig()).toEqual({
        budget_tokens: 42000,
      });
    });

    it.each([
      ['qwen3.7-plus', 'none', false],
      ['qwen3.8-max', 'low', true],
      ['qwen3.8-max', 'max', false],
    ] as const)(
      'reloads persisted reasoning for %s with %s after a workspace model rebuild',
      (modelId, selection, clearsOverrides) => {
        const state = installReasoningPreference('low');
        const extraBody = {
          enable_thinking: false,
          reasoning_effort: 'xhigh',
          seed: 7,
        };
        const samplingParams = { thinking_budget: 1024, temperature: 0.2 };
        currentModel = modelId;
        for (const generation of [state.live, state.rebuildable]) {
          Object.assign(generation, {
            model: modelId,
            reasoning: undefined,
            extra_body: extraBody,
            samplingParams,
          });
        }
        vi.mocked(mockSettings.reloadScopeFromDisk).mockImplementation(() => {
          state.user.settings.model.reasoningEffort = selection;
          mockSettings.recomputeMerged();
          return true;
        });
        session.reloadReasoningSelection();
        expect(mockSettings.reloadScopeFromDisk).toHaveBeenCalledWith(
          SettingScope.User,
        );
        expect(mockSettings.reloadScopeFromDisk).toHaveBeenCalledWith(
          SettingScope.Workspace,
        );
        const expected =
          selection === 'none'
            ? false
            : selection === 'low'
              ? { effort: 'low' }
              : undefined;
        expect(state.live.reasoning).toEqual(expected);
        expect(state.rebuildable.reasoning).toEqual(expected);
        expect(state.live.extra_body).toEqual(
          clearsOverrides ? { seed: 7 } : extraBody,
        );
        expect(state.live.samplingParams).toEqual(
          clearsOverrides ? { temperature: 0.2 } : samplingParams,
        );
        expect(state.rebuildable.extra_body).toEqual({
          enable_thinking: false,
          reasoning_effort: 'xhigh',
          seed: 7,
        });
        expect(state.rebuildable.samplingParams).toEqual({
          thinking_budget: 1024,
          temperature: 0.2,
        });
      },
    );

    it('keeps a model switch live when incompatible preference cleanup fails', async () => {
      const state = installReasoningPreference('max');
      const setValue = vi.mocked(mockSettings.setValue);
      const write = setValue.getMockImplementation();
      setValue.mockImplementation((scope, key, value, ...rest) => {
        if (key === 'model.reasoningEffort' && value === undefined) {
          throw new Error('settings are read-only');
        }
        return write?.(scope, key, value, ...rest);
      });

      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: `qwen3.7-plus(${AuthType.USE_OPENAI})`,
        }),
      ).resolves.toBeDefined();

      expect(state.live.reasoning).toBeUndefined();
      expect(mockChatRecordingService.recordSessionModel).toHaveBeenCalledWith({
        modelId: 'qwen3.7-plus',
        authType: AuthType.USE_OPENAI,
      });
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'model.name',
        'qwen3.7-plus',
      );
    });

    it.each(['none', 'default'] as const)(
      'persists %s in the model scope and removes shadowing tiers',
      (selection) => {
        const state = installReasoningPreference('max', { trusted: true });
        session.persistReasoningSelection(selection);
        for (const field of ['settings', 'originalSettings'] as const) {
          expect(state.user[field].model).toStrictEqual(
            selection === 'default' ? {} : { reasoningEffort: selection },
          );
          expect(state.workspace[field].model).not.toHaveProperty(
            'reasoningEffort',
          );
        }
        expect(mockSettings.merged.model?.reasoningEffort).toBe(
          selection === 'default' ? undefined : selection,
        );
      },
    );

    it.each(['medium', 'default'] as const)(
      'preserves scope values when persisting %s fails',
      (selection) => {
        const state = installReasoningPreference(
          selection === 'medium' ? 'low' : 'max',
          { trusted: true },
        );
        if (selection === 'medium') {
          Object.assign(state.workspace.settings, { modelProviders: {} });
          Object.assign(state.workspace.originalSettings, {
            modelProviders: {},
          });
          delete state.workspace.settings.model.reasoningEffort;
          delete state.workspace.originalSettings.model.reasoningEffort;
          mockSettings.recomputeMerged();
        }
        const files = [state.user, state.workspace];
        const before = files.map((file) => ({ ...file.settings.model }));
        const setValue = vi.mocked(mockSettings.setValue);
        const write = setValue.getMockImplementation();
        setValue.mockImplementation((scope, key, value, ...rest) => {
          if (
            key === 'model.reasoningEffort' &&
            scope ===
              (selection === 'medium'
                ? SettingScope.Workspace
                : SettingScope.User) &&
            value === (selection === 'medium' ? selection : undefined)
          ) {
            throw new Error('settings are read-only');
          }
          return write?.(scope, key, value, ...rest);
        });

        expect(() => session.persistReasoningSelection(selection)).toThrow(
          'settings are read-only',
        );
        files.forEach((file, index) => {
          expect(file.settings.model).toStrictEqual(before[index]);
          expect(file.originalSettings.model).toStrictEqual(before[index]);
        });
      },
    );

    it.each([
      [AuthType.USE_OPENAI, 'qwen3-coder-flash', false],
      [AuthType.QWEN_SUBSCRIPTION, 'qwen3.8-max', true],
    ] as const)(
      'switches standalone %s using only the session config',
      async (authType, modelId, refresh) => {
        session.dispose();
        vi.mocked(mockConfig.getSessionSourceType).mockReturnValue(
          'standalone',
        );
        const refreshSubscriptionModels = vi.fn().mockResolvedValue({
          models: [modelId],
          cached: false,
        });
        Object.assign(mockConfig, { refreshSubscriptionModels });
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );

        await session.setModel(
          {
            sessionId: 'test-session-id',
            modelId: `${modelId}(${authType})`,
          },
          { persistDefault: true },
        );

        expect(mockConfig.switchModel).toHaveBeenCalledWith(
          authType,
          modelId,
          undefined,
        );
        expect(mockSettings.setValue).not.toHaveBeenCalled();
        if (refresh) {
          expect(refreshSubscriptionModels).toHaveBeenCalledOnce();
          expect(refreshSubscriptionModels).toHaveBeenCalledBefore(
            switchModelSpy,
          );
        } else {
          expect(refreshSubscriptionModels).not.toHaveBeenCalled();
        }
        expect(
          mockChatRecordingService.recordSessionModel,
        ).toHaveBeenCalledWith({
          modelId,
          authType,
        });
      },
    );

    it.each([
      'qwen3.8-max(qwen-subscription)',
      '$runtime|qwen-subscription|qwen3.8-max(openai)',
    ])(
      'enforces session auth policy for %s before refreshing models',
      async (modelId) => {
        session.dispose();
        vi.mocked(mockConfig.getSessionSourceType).mockReturnValue(
          'standalone',
        );
        const refreshSubscriptionModels = vi.fn();
        Object.assign(mockConfig, { refreshSubscriptionModels });
        mockSettings.merged.security = {
          auth: { enforcedType: AuthType.USE_OPENAI },
        };
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );

        await expect(
          session.setModel({
            sessionId: 'test-session-id',
            modelId,
          }),
        ).rejects.toMatchObject({ data: { errorKind: 'auth_type_enforced' } });
        expect(refreshSubscriptionModels).not.toHaveBeenCalled();
        expect(switchModelSpy).not.toHaveBeenCalled();
        expect(mockSettings.setValue).not.toHaveBeenCalled();
      },
    );

    it('propagates errors from config.switchModel', async () => {
      const configError = new Error('Invalid model');
      switchModelSpy.mockRejectedValueOnce(configError);

      await expect(
        session.setModel({
          sessionId: 'test-session-id',
          modelId: `invalid-model(${AuthType.USE_OPENAI})`,
        }),
      ).rejects.toThrow('Invalid model');
      expect(mockSettings.setValue).not.toHaveBeenCalled();
    });
  });

  describe('sendAvailableCommandsUpdate', () => {
    describe('wire update deduplication', () => {
      const initialSnapshot = {
        availableCommands: [
          {
            name: 'init',
            description: 'Initialize project context',
            input: null,
          },
        ],
      };
      const changedSnapshot = {
        availableCommands: [
          { name: 'review', description: 'Review code changes', input: null },
        ],
      };
      let buildSnapshot: MockInstance<
        Session['buildAvailableCommandsSnapshot']
      >;

      beforeEach(() => {
        buildSnapshot = vi
          .spyOn(session, 'buildAvailableCommandsSnapshot')
          .mockResolvedValue(initialSnapshot);
        mockConfig.refreshWorkflowMode = vi.fn();
        mockConfig.getSkillManager = vi.fn().mockReturnValue(null);
      });

      it('sends the first empty snapshot and refreshes Workflow mode on duplicates', async () => {
        buildSnapshot.mockResolvedValue({ availableCommands: [] });

        await session.sendAvailableCommandsUpdate();
        buildSnapshot.mockResolvedValue({ availableCommands: [] });
        await session.sendAvailableCommandsUpdate();

        expect(buildSnapshot).toHaveBeenCalledTimes(2);
        expect(mockConfig.refreshWorkflowMode).toHaveBeenCalledTimes(2);
        expect(mockClient.sessionUpdate).toHaveBeenCalledExactlyOnceWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [],
          },
        });
      });

      it('keeps successful hashes scoped to each Session', async () => {
        await session.sendAvailableCommandsUpdate();
        session.dispose();
        session = new Session(
          'second-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );
        vi.spyOn(session, 'buildAvailableCommandsSnapshot').mockResolvedValue(
          initialSnapshot,
        );

        await session.sendAvailableCommandsUpdate();

        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(2);
        expect(vi.mocked(mockClient.sessionUpdate).mock.calls[1][0]).toEqual({
          sessionId: 'second-session-id',
          update: {
            sessionUpdate: 'available_commands_update',
            ...initialSnapshot,
          },
        });
      });

      it('sends changed commands and a return to an earlier successful snapshot', async () => {
        await session.sendAvailableCommandsUpdate();
        buildSnapshot.mockResolvedValue(changedSnapshot);
        await session.sendAvailableCommandsUpdate();
        await session.sendAvailableCommandsUpdate();
        buildSnapshot.mockResolvedValue(initialSnapshot);
        await session.sendAvailableCommandsUpdate();

        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.map(([notification]) => notification.update),
        ).toEqual(
          [initialSnapshot, changedSnapshot, initialSnapshot].map(
            (snapshot) => ({
              sessionUpdate: 'available_commands_update',
              ...snapshot,
            }),
          ),
        );
        expect(mockConfig.refreshWorkflowMode).toHaveBeenCalledTimes(4);
      });

      it('sends changes to command metadata even when names stay the same', async () => {
        await session.sendAvailableCommandsUpdate();
        const snapshot = {
          availableCommands: [
            {
              ...initialSnapshot.availableCommands[0],
              _meta: { altNames: ['initialize'] },
            },
          ],
        };
        buildSnapshot.mockResolvedValue(snapshot);
        await session.sendAvailableCommandsUpdate();
        await session.sendAvailableCommandsUpdate();

        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockClient.sessionUpdate).mock.calls[1][0].update,
        ).toEqual({ sessionUpdate: 'available_commands_update', ...snapshot });
      });

      it('sends skill body changes and retains only a fixed-size wire hash', async () => {
        const skill = {
          name: 'review',
          description: 'Review code changes',
          body: 'x'.repeat(2_550_000),
          filePath: '/skills/review/SKILL.md',
          level: 'user',
        };
        const snapshot = {
          ...initialSnapshot,
          availableSkills: ['review'],
          availableSkillDetails: [skill],
        };
        buildSnapshot.mockResolvedValue(snapshot);
        await session.sendAvailableCommandsUpdate();
        buildSnapshot.mockResolvedValue({
          ...snapshot,
          availableSkillDetails: [{ ...skill, body: `${skill.body}y` }],
        });
        await session.sendAvailableCommandsUpdate();
        await session.sendAvailableCommandsUpdate();

        const updates = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([notification]) => notification.update);
        expect(updates).toHaveLength(2);
        expect(updates[0]).toEqual({
          sessionUpdate: 'available_commands_update',
          availableCommands: snapshot.availableCommands,
          _meta: {
            availableSkills: snapshot.availableSkills,
            availableSkillDetails: [skill],
          },
        });
        expect(updates[1]).toEqual({
          ...updates[0],
          _meta: {
            availableSkills: snapshot.availableSkills,
            availableSkillDetails: [{ ...skill, body: `${skill.body}y` }],
          },
        });
        const hash = createHash('sha256')
          .update(JSON.stringify(updates[1]))
          .digest('hex');
        expect(hash).toHaveLength(64);
        expect(session).toHaveProperty(
          'lastSuccessfulAvailableCommandsHash',
          hash,
        );
        expect(mockConfig.refreshWorkflowMode).toHaveBeenCalledTimes(3);
      });

      it('retries the same update queued behind a failed send', async () => {
        const error = new Error('client update failed');
        let rejectSend!: (error: Error) => void;
        vi.mocked(mockClient.sessionUpdate).mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectSend = reject;
            }),
        );
        const first = session.refreshSkillsFromSettings();
        const failure = first.catch((error: unknown) => error);
        const retry = session.refreshSkillsFromSettings();
        await vi.waitFor(() =>
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1),
        );
        expect(buildSnapshot).toHaveBeenCalledTimes(1);

        rejectSend(error);
        await expect(failure).resolves.toBe(error);
        await expect(retry).resolves.toBeUndefined();
        await session.sendAvailableCommandsUpdate();

        expect(buildSnapshot).toHaveBeenCalledTimes(3);
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(mockClient.sessionUpdate).mock.calls;
        expect(calls[1][0].update).toEqual(calls[0][0].update);
      });

      it('recovers the queue after snapshot discovery fails', async () => {
        buildSnapshot.mockRejectedValueOnce(
          new Error('Command discovery failed'),
        );

        await expect(
          session.sendAvailableCommandsUpdate(),
        ).resolves.toBeUndefined();
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        await session.sendAvailableCommandsUpdate();

        expect(buildSnapshot).toHaveBeenCalledTimes(2);
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      });

      it('serializes concurrent duplicates until the first send succeeds', async () => {
        let finishSend!: () => void;
        vi.mocked(mockClient.sessionUpdate).mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishSend = resolve;
            }),
        );
        const first = session.sendAvailableCommandsUpdate();
        const duplicate = session.sendAvailableCommandsUpdate();
        await vi.waitFor(() =>
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1),
        );
        expect(buildSnapshot).toHaveBeenCalledTimes(1);
        expect(session).toHaveProperty(
          'lastSuccessfulAvailableCommandsHash',
          undefined,
        );

        finishSend();
        await Promise.all([first, duplicate]);

        expect(buildSnapshot).toHaveBeenCalledTimes(2);
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
        expect(mockConfig.refreshWorkflowMode).toHaveBeenCalledTimes(2);
      });

      it('builds and sends concurrent changes in call order', async () => {
        let finishBuild!: (snapshot: typeof initialSnapshot) => void;
        let finishSend!: () => void;
        buildSnapshot
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finishBuild = resolve;
              }),
          )
          .mockResolvedValueOnce(changedSnapshot);
        vi.mocked(mockClient.sessionUpdate).mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishSend = resolve;
            }),
        );
        const first = session.sendAvailableCommandsUpdate();
        const changed = session.sendAvailableCommandsUpdate();
        const reverted = session.sendAvailableCommandsUpdate();
        await vi.waitFor(() => expect(buildSnapshot).toHaveBeenCalledTimes(1));
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();

        finishBuild(initialSnapshot);
        await vi.waitFor(() =>
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1),
        );
        expect(buildSnapshot).toHaveBeenCalledTimes(1);
        finishSend();
        await Promise.all([first, changed, reverted]);

        expect(buildSnapshot).toHaveBeenCalledTimes(3);
        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.map(([notification]) => notification.update),
        ).toEqual(
          [initialSnapshot, changedSnapshot, initialSnapshot].map(
            (snapshot) => ({
              sessionUpdate: 'available_commands_update',
              ...snapshot,
            }),
          ),
        );
      });

      it('drops queued updates when disposed before the queue runs', async () => {
        const pending = session.sendAvailableCommandsUpdate();
        session.dispose();
        await pending;

        expect(buildSnapshot).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      });

      it('does not send or build later queued updates when disposed during a build', async () => {
        let finishBuild!: (snapshot: typeof initialSnapshot) => void;
        buildSnapshot.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishBuild = resolve;
            }),
        );
        const first = session.sendAvailableCommandsUpdate();
        const queued = session.sendAvailableCommandsUpdate();
        await vi.waitFor(() => expect(buildSnapshot).toHaveBeenCalledTimes(1));

        session.dispose();
        finishBuild(initialSnapshot);
        await Promise.all([first, queued]);

        expect(buildSnapshot).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        expect(session).toHaveProperty(
          'lastSuccessfulAvailableCommandsHash',
          undefined,
        );
      });

      it('does not commit a hash or send queued updates when disposed during a send', async () => {
        let finishSend!: () => void;
        vi.mocked(mockClient.sessionUpdate).mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishSend = resolve;
            }),
        );
        const first = session.sendAvailableCommandsUpdate();
        const queued = session.sendAvailableCommandsUpdate();
        await vi.waitFor(() =>
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1),
        );

        session.dispose();
        finishSend();
        await Promise.all([first, queued]);

        expect(buildSnapshot).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
        expect(session).toHaveProperty(
          'lastSuccessfulAvailableCommandsHash',
          undefined,
        );
      });
    });

    it('sends available_commands_update from getAvailableCommands()', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'init',
          description: 'Initialize project context',
          kind: 'built-in',
          argumentHint: '[path]',
          source: 'builtin-command',
          sourceLabel: 'Built-in',
          supportedModes: ['interactive', 'non_interactive', 'acp'],
          modelInvocable: false,
          subCommands: [
            {
              name: 'visible',
              description: 'Visible subcommand',
              kind: CommandKind.BUILT_IN,
            },
            {
              name: 'hidden',
              description: 'Hidden subcommand',
              kind: CommandKind.BUILT_IN,
              hidden: true,
            },
          ],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(getAvailableCommandsSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.any(AbortSignal),
        'acp',
        mockSettings,
        undefined,
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize project context',
              input: { hint: '[path]' },
              _meta: {
                argumentHint: '[path]',
                source: 'builtin-command',
                sourceLabel: 'Built-in',
                supportedModes: ['interactive', 'non_interactive', 'acp'],
                subcommands: ['visible'],
                modelInvocable: false,
              },
            },
          ],
        },
      });
    });

    it('applies the immutable standalone command policy after binding release', async () => {
      session.dispose();
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
      vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
      getAvailableCommandsSpy.mockResolvedValue([]);
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

      await vi.waitFor(() =>
        expect(getAvailableCommandsSpy).toHaveBeenCalledWith(
          mockConfig,
          expect.any(AbortSignal),
          'acp',
          mockSettings,
          {
            allowSessionReset: false,
            allowWorkspaceSettingsWrite: false,
            persistModelSelection: false,
            blockedBuiltinCommandNames: [
              'cd',
              'clear',
              'directory',
              'diff',
              'dream',
              'export',
              'learn',
              'curator',
              'workflows',
            ],
          },
        ),
      );
    });

    it('forwards command descriptions from getAvailableCommands()', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'review',
          description: '审查代码变更',
          kind: CommandKind.SKILL,
          source: 'skill-dir-command',
          sourceLabel: '用户',
          sourceDetail: 'user',
          supportedModes: ['acp'],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(getAvailableCommandsSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.any(AbortSignal),
        'acp',
        mockSettings,
        undefined,
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'review',
              description: '审查代码变更',
              input: { hint: '' },
              _meta: {
                argumentHint: undefined,
                source: 'skill-dir-command',
                sourceLabel: '用户',
                supportedModes: ['acp'],
                subcommands: [],
                modelInvocable: false,
              },
            },
          ],
        },
      });
    });

    it('forwards command aliases as _meta.altNames (and omits the key when there are none)', async () => {
      // A channel consumer only sees this wire snapshot, not the command registry,
      // so aliases must travel in _meta (ACP's extension point) for it to recognize
      // an aliased command. Omitted when absent so non-aliased entries stay
      // byte-identical.
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'compress',
          description: 'Compress context',
          altNames: ['summarize'],
          kind: CommandKind.BUILT_IN,
        },
        {
          name: 'help',
          description: 'Show help',
          kind: CommandKind.BUILT_IN,
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              expect.objectContaining({
                name: 'compress',
                _meta: expect.objectContaining({ altNames: ['summarize'] }),
              }),
              expect.objectContaining({ name: 'help' }),
            ],
          }),
        }),
      );
      // The alias-free command carries no altNames key.
      const call = (
        mockClient.sessionUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.at(-1)![0] as {
        update: {
          availableCommands: Array<{ _meta?: Record<string, unknown> }>;
        };
      };
      expect(call.update.availableCommands[1]._meta).not.toHaveProperty(
        'altNames',
      );
    });

    it('sets input for built-in commands with subCommands', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'export',
          description: 'Export conversation history',
          kind: 'built-in',
          subCommands: [
            { name: 'md', description: 'Export as markdown', kind: 'built-in' },
          ],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'export',
              description: 'Export conversation history',
              input: { hint: '' },
              _meta: {
                argumentHint: undefined,
                source: undefined,
                sourceLabel: undefined,
                supportedModes: ['interactive'],
                subcommands: ['md'],
                modelInvocable: false,
              },
            },
          ],
        },
      });
    });

    it('honors explicit no-input override for built-in commands with subCommands', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'doctor',
          description: 'Run installation and environment diagnostics',
          kind: 'built-in',
          acceptsInput: false,
          subCommands: [
            {
              name: 'memory',
              description: 'Show current process memory diagnostics',
              kind: 'built-in',
            },
          ],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
            availableCommands: expect.arrayContaining([
              expect.objectContaining({
                name: 'doctor',
                description: 'Run installation and environment diagnostics',
                input: null,
              }),
            ]),
          }),
        }),
      );
    });

    it('honors explicit input override for built-in commands without input metadata', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'diagnostics',
          description: 'Run diagnostics',
          kind: 'built-in',
          acceptsInput: true,
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
            availableCommands: expect.arrayContaining([
              expect.objectContaining({
                name: 'diagnostics',
                description: 'Run diagnostics',
                input: { hint: '' },
              }),
            ]),
          }),
        }),
      );
    });

    it('attaches available skills to available_commands_update metadata', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'init',
          description: 'Initialize project context',
          kind: 'built-in',
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'code-review-expert',
            description: 'Review code changes',
            body: 'Review instructions',
            filePath: '/skills/code-review-expert/SKILL.md',
            level: 'user',
          },
          {
            name: 'verification-pack',
            description: 'Verify changes',
            body: 'Verification instructions',
            filePath: '/skills/verification-pack/SKILL.md',
            level: 'project',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'init',
              description: 'Initialize project context',
              input: null,
              _meta: {
                argumentHint: undefined,
                source: undefined,
                sourceLabel: undefined,
                supportedModes: ['interactive'],
                subcommands: [],
                modelInvocable: false,
              },
            },
          ],
          _meta: {
            availableSkills: ['code-review-expert', 'verification-pack'],
            availableSkillDetails: [
              {
                name: 'code-review-expert',
                description: 'Review code changes',
                body: 'Review instructions',
                filePath: '/skills/code-review-expert/SKILL.md',
                level: 'user',
                modelInvocable: true,
              },
              {
                name: 'verification-pack',
                description: 'Verify changes',
                body: 'Verification instructions',
                filePath: '/skills/verification-pack/SKILL.md',
                level: 'project',
                modelInvocable: true,
              },
            ],
          },
        },
      });
    });

    it('derives skill details from skill slash commands', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'batch',
          description: 'Run a batch operation',
          kind: 'skill',
          argumentHint: '<operation> <file-pattern>',
          skillDetail: {
            name: 'batch',
            description: 'Run a batch operation',
            body: 'Batch instructions',
            level: 'bundled',
          },
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue(null);

      await session.sendAvailableCommandsUpdate();

      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'batch',
              description: 'Run a batch operation',
              input: { hint: '<operation> <file-pattern>' },
              _meta: {
                argumentHint: '<operation> <file-pattern>',
                source: undefined,
                sourceLabel: undefined,
                supportedModes: ['interactive', 'non_interactive', 'acp'],
                subcommands: [],
                modelInvocable: false,
              },
            },
          ],
          _meta: {
            availableSkills: ['batch'],
            availableSkillDetails: [
              {
                name: 'batch',
                description: 'Run a batch operation',
                body: 'Batch instructions',
                level: 'bundled',
                modelInvocable: false,
              },
            ],
          },
        },
      });
    });

    it('derives availableSkills from skillManager and skill slash commands combined', async () => {
      // Both sources contribute: a skillManager skill AND a bundled skill
      // slash-command. The unconditional derivation must list both and keep
      // availableSkills consistent with availableSkillDetails (the `??=` fix).
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'batch',
          description: 'Run a batch operation',
          kind: 'skill',
          skillDetail: {
            name: 'batch',
            description: 'Run a batch operation',
            body: 'Batch instructions',
            level: 'bundled',
          },
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'mgr-skill',
            description: 'From the skill manager',
            body: 'Manager instructions',
            filePath: '/skills/mgr-skill/SKILL.md',
            level: 'user',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      const meta = (
        vi.mocked(mockClient.sessionUpdate).mock.calls.at(-1)![0] as {
          update: {
            _meta: {
              availableSkills: string[];
              availableSkillDetails: Array<{ name: string }>;
            };
          };
        }
      ).update._meta;
      expect(meta.availableSkills).toEqual(
        expect.arrayContaining(['mgr-skill', 'batch']),
      );
      expect(meta.availableSkills).toHaveLength(2);
      // Name list stays in lockstep with the details list.
      expect([...meta.availableSkills].sort()).toEqual(
        meta.availableSkillDetails.map((detail) => detail.name).sort(),
      );
    });

    it('omits skills disabled in settings from availableSkills and details', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'disabled-command',
          description: 'Disabled slash skill',
          kind: 'skill',
          skillDetail: {
            name: 'disabled-command',
            description: 'Disabled slash skill',
            body: 'Hidden instructions',
            level: 'project',
          },
        },
      ]);
      mockConfig.getDisabledSkillNames = vi
        .fn()
        .mockReturnValue(new Set(['disabled-skill', 'disabled-command']));
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'enabled-skill',
            description: 'Enabled skill',
            body: 'Visible instructions',
            filePath: '/skills/enabled-skill/SKILL.md',
            level: 'project',
          },
          {
            name: 'disabled-skill',
            description: 'Disabled skill',
            body: 'Hidden instructions',
            filePath: '/skills/disabled-skill/SKILL.md',
            level: 'project',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      const update = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([call]) => call)
        .find(
          (call) => call.update.sessionUpdate === 'available_commands_update',
        ) as {
        update: {
          availableCommands: Array<{ name: string }>;
          _meta: {
            availableSkills: string[];
            availableSkillDetails: Array<{ name: string }>;
          };
        };
      };
      expect(
        update.update.availableCommands.map((command) => command.name),
      ).not.toContain('disabled-command');
      const meta = update.update._meta;
      expect(meta.availableSkills).toEqual(['enabled-skill']);
      expect(meta.availableSkillDetails.map((detail) => detail.name)).toEqual([
        'enabled-skill',
      ]);
    });

    it('omits inactive extension skills from availableSkills and details', async () => {
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          name: 'disabled-ext',
          displayName: 'Disabled Extension',
          isActive: false,
          skills: [
            {
              name: 'disabled-extension-skill',
              description: 'Disabled extension skill',
              body: 'Hidden instructions',
              filePath: '/skills/disabled/SKILL.md',
              level: 'extension',
            },
          ],
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'active-extension-skill',
            description: 'Active extension skill',
            body: 'Visible instructions',
            filePath: '/skills/active/SKILL.md',
            level: 'extension',
            extensionName: 'active-ext',
          },
          {
            name: 'display-name-collision-skill',
            description: 'Active extension skill with colliding name',
            body: 'Visible collision instructions',
            filePath: '/skills/collision/SKILL.md',
            level: 'extension',
            extensionName: 'active-ext',
            extensionDisplayName: 'Disabled Extension',
          },
          {
            name: 'disabled-extension-skill',
            description: 'Disabled extension skill',
            body: 'Hidden instructions',
            filePath: '/skills/disabled/SKILL.md',
            level: 'extension',
            extensionName: 'disabled-ext',
            extensionDisplayName: 'Disabled Extension',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      const update = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([call]) => call)
        .find(
          (call) => call.update.sessionUpdate === 'available_commands_update',
        ) as {
        update: {
          _meta: {
            availableSkills: string[];
            availableSkillDetails: Array<{ name: string }>;
          };
        };
      };
      const meta = update.update._meta;
      expect(meta.availableSkills).toEqual([
        'active-extension-skill',
        'display-name-collision-skill',
      ]);
      expect(meta.availableSkillDetails.map((detail) => detail.name)).toEqual([
        'active-extension-skill',
        'display-name-collision-skill',
      ]);
    });

    it('does not restore inactive extension skills from skill slash commands', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'disabled-extension-skill',
          description: 'Disabled extension skill',
          kind: 'skill',
          skillDetail: {
            name: 'disabled-extension-skill',
            description: 'Disabled extension skill',
            body: 'Hidden instructions',
            level: 'extension',
            extensionName: 'disabled-ext',
          },
        },
      ]);
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          name: 'disabled-ext',
          isActive: false,
          skills: [
            {
              name: 'disabled-extension-skill',
              description: 'Disabled extension skill',
              body: 'Hidden instructions',
              filePath: '/skills/disabled/SKILL.md',
              level: 'extension',
            },
          ],
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'disabled-extension-skill',
            description: 'Disabled extension skill',
            body: 'Hidden instructions',
            filePath: '/skills/disabled/SKILL.md',
            level: 'extension',
            extensionName: 'disabled-ext',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      const update = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([call]) => call)
        .find(
          (call) => call.update.sessionUpdate === 'available_commands_update',
        ) as {
        update: {
          availableCommands: Array<{ name: string }>;
          _meta?: {
            availableSkills: string[];
            availableSkillDetails: Array<{ name: string }>;
          };
        };
      };
      expect(
        update.update.availableCommands.map((command) => command.name),
      ).not.toContain('disabled-extension-skill');
      expect(update.update._meta).toBeUndefined();
    });

    it('omits inactive extension skills whose slash command carries the qualified registry name', async () => {
      // The loader qualifies extension skill commands as `<ext>:<authored>`
      // and carries the authored spelling on skillDetail, while the
      // inactive-extension refs key on the manifest's authored spelling.
      // Dropping the authoredName propagation into
      // isInactiveExtensionSkill would miss that lookup and leak the
      // inactive skill into the snapshot.
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'disabled-ext:pdf',
          description: 'Inactive skill',
          kind: 'skill',
          skillDetail: {
            name: 'disabled-ext:pdf',
            authoredName: 'pdf',
            description: 'Inactive skill',
            body: 'Hidden instructions',
            level: 'extension',
            extensionName: 'disabled-ext',
          },
        },
      ]);
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          name: 'disabled-ext',
          isActive: false,
          skills: [
            {
              name: 'pdf',
              description: 'Inactive skill',
              body: 'Hidden instructions',
              filePath: '/skills/disabled/SKILL.md',
              level: 'extension',
            },
          ],
        },
      ]);

      await session.sendAvailableCommandsUpdate();

      const update = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([call]) => call)
        .find(
          (call) => call.update.sessionUpdate === 'available_commands_update',
        ) as { update: { availableCommands: Array<{ name: string }> } };
      expect(
        update.update.availableCommands.map((command) => command.name),
      ).not.toContain('disabled-ext:pdf');
    });

    it('keeps active extension slash commands that share a skill name with inactive extensions', async () => {
      getAvailableCommandsSpy.mockResolvedValueOnce([
        {
          name: 'review',
          description: 'Active review skill',
          kind: 'skill',
          skillDetail: {
            name: 'review',
            description: 'Active review skill',
            body: 'Visible instructions',
            level: 'extension',
            extensionName: 'active-ext',
          },
        },
      ]);
      mockConfig.getExtensions = vi.fn().mockReturnValue([
        {
          name: 'disabled-ext',
          isActive: false,
          skills: [
            {
              name: 'review',
              description: 'Disabled review skill',
              body: 'Hidden instructions',
              filePath: '/skills/disabled-review/SKILL.md',
              level: 'extension',
            },
          ],
        },
      ]);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([
          {
            name: 'review',
            description: 'Active review skill',
            body: 'Visible instructions',
            filePath: '/skills/active-review/SKILL.md',
            level: 'extension',
            extensionName: 'active-ext',
          },
        ]),
      });

      await session.sendAvailableCommandsUpdate();

      const update = vi
        .mocked(mockClient.sessionUpdate)
        .mock.calls.map(([call]) => call)
        .find(
          (call) => call.update.sessionUpdate === 'available_commands_update',
        ) as {
        update: {
          availableCommands: Array<{ name: string }>;
          _meta: {
            availableSkills: string[];
            availableSkillDetails: Array<{ name: string }>;
          };
        };
      };
      expect(
        update.update.availableCommands.map((command) => command.name),
      ).toContain('review');
      expect(update.update._meta.availableSkills).toEqual(['review']);
      expect(update.update._meta.availableSkillDetails).toEqual([
        expect.objectContaining({ name: 'review' }),
      ]);
    });

    it('swallows errors and does not throw', async () => {
      getAvailableCommandsSpy.mockRejectedValueOnce(
        new Error('Command discovery failed'),
      );

      await expect(
        session.sendAvailableCommandsUpdate(),
      ).resolves.toBeUndefined();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'atomically re-reads User and Workspace skill settings (success=%s)',
      (success) => {
        vi.mocked(
          mockSettings.reloadScopesFromDiskAtomically,
        ).mockReturnValueOnce(success);
        if (success)
          expect(() => session.reloadSkillSettings(true)).not.toThrow();
        else
          expect(() => session.reloadSkillSettings(true)).toThrow(
            'Failed to reload user skill settings',
          );
        expect(
          mockSettings.reloadScopesFromDiskAtomically,
        ).toHaveBeenCalledWith([SettingScope.Workspace, SettingScope.User]);
        expect(mockSettings.reloadScopeFromDisk).not.toHaveBeenCalled();
      },
    );

    it('refreshes workspace skill settings, commands, and SkillManager consumers', async () => {
      const suppressNextSlashReload = vi.fn();
      const notifyConfigChanged = vi.fn().mockResolvedValue(undefined);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
        suppressNextSlashReload,
        notifyConfigChanged,
      });

      await session.refreshSkillsFromSettings();

      expect(mockSettings.reloadScopeFromDisk).toHaveBeenCalledWith(
        SettingScope.Workspace,
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
          }),
        }),
      );
      expect(suppressNextSlashReload).toHaveBeenCalledTimes(1);
      expect(notifyConfigChanged).toHaveBeenCalledTimes(1);

      await session.refreshSkillsFromSettings();

      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(mockSettings.reloadScopeFromDisk).toHaveBeenCalledTimes(2);
      expect(suppressNextSlashReload).toHaveBeenCalledTimes(2);
      expect(notifyConfigChanged).toHaveBeenCalledTimes(2);
    });

    it('publishes refreshed skill content without reloading settings or notifying twice', async () => {
      const notifyConfigChanged = vi.fn().mockResolvedValue(undefined);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
        suppressNextSlashReload: vi.fn(),
        notifyConfigChanged,
      });

      await session.refreshSkillsFromSettings({
        reloadSettings: false,
        notifyConfigChanged: false,
      });

      expect(mockSettings.reloadScopeFromDisk).not.toHaveBeenCalled();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'available_commands_update',
          }),
        }),
      );
      expect(notifyConfigChanged).not.toHaveBeenCalled();
    });

    it('does not publish refreshed skills while standalone activation is held', async () => {
      session.dispose();
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
      vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
      mockConfig.getSkillManager = vi.fn().mockReturnValue(null);
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
      getAvailableCommandsSpy.mockClear();
      vi.mocked(mockClient.sessionUpdate).mockClear();

      await session.refreshSkillsFromSettings({
        reloadSettings: false,
        notifyConfigChanged: false,
      });

      expect(getAvailableCommandsSpy).not.toHaveBeenCalled();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();

      await session.releaseManagedConversationBinding(expectation);

      await vi.waitFor(() =>
        expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1),
      );
      expect(getAvailableCommandsSpy).toHaveBeenCalledTimes(1);

      await session.sendAvailableCommandsUpdate();

      expect(getAvailableCommandsSpy).toHaveBeenCalledTimes(2);
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
    });

    it('drops a snapshot when standalone activation becomes held during its build', async () => {
      session.dispose();
      vi.mocked(mockConfig.getSessionSourceType).mockReturnValue('standalone');
      vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
      mockConfig.getSkillManager = vi.fn().mockReturnValue(null);
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
      const assertIdentity = vi.fn().mockResolvedValue(undefined);
      const snapshot = { availableCommands: [] };
      let finishBuild!: (value: typeof snapshot) => void;
      const buildSnapshot = vi
        .spyOn(session, 'buildAvailableCommandsSnapshot')
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishBuild = resolve;
            }),
        )
        .mockResolvedValue(snapshot);
      session.installPendingManagedConversationBinding(
        expectation,
        assertIdentity,
      );
      await session.commitManagedConversationBinding(expectation);
      await session.releaseManagedConversationBinding(expectation);
      await vi.waitFor(() => expect(buildSnapshot).toHaveBeenCalledTimes(1));

      session.installPendingManagedConversationBinding(
        expectation,
        assertIdentity,
      );
      finishBuild(snapshot);
      await session.sendAvailableCommandsUpdate();

      expect(buildSnapshot).toHaveBeenCalledTimes(1);
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();

      await session.commitManagedConversationBinding(expectation);
      await session.releaseManagedConversationBinding(expectation);
      await session.sendAvailableCommandsUpdate();

      expect(buildSnapshot).toHaveBeenCalledTimes(3);
      expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
    });

    it('notifies SkillManager when the command update fails', async () => {
      const suppressNextSlashReload = vi.fn();
      const notifyConfigChanged = vi.fn().mockResolvedValue(undefined);
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
        suppressNextSlashReload,
        notifyConfigChanged,
      });
      vi.mocked(mockClient.sessionUpdate).mockRejectedValueOnce(
        new Error('client update failed'),
      );

      await expect(session.refreshSkillsFromSettings()).rejects.toThrow(
        'client update failed',
      );

      expect(mockSettings.reloadScopeFromDisk).toHaveBeenCalledWith(
        SettingScope.Workspace,
      );
      expect(suppressNextSlashReload).toHaveBeenCalledTimes(1);
      expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
    });

    it('preserves the command update error when SkillManager notification also fails', async () => {
      const notifyConfigChanged = vi
        .fn()
        .mockRejectedValue(new Error('notification failed'));
      mockConfig.getSkillManager = vi.fn().mockReturnValue({
        listSkills: vi.fn().mockResolvedValue([]),
        suppressNextSlashReload: vi.fn(),
        notifyConfigChanged,
      });
      vi.mocked(mockClient.sessionUpdate).mockRejectedValueOnce(
        new Error('client update failed'),
      );

      await expect(session.refreshSkillsFromSettings()).rejects.toThrow(
        'client update failed',
      );

      expect(notifyConfigChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('prompt', () => {
    it('anchors approval state before recording the first real user message', async () => {
      const order: string[] = [];
      mockChatRecordingService.recordSessionApprovalMode.mockImplementation(
        async () => {
          order.push('approval');
          return true;
        },
      );
      mockChatRecordingService.recordUserMessage.mockImplementation(() => {
        order.push('user');
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(order.slice(0, 2)).toEqual(['approval', 'user']);
    });

    it('does not record a branch checkpoint for a channel prompt', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      mockChatRecordingService.getBranchCheckpointCursor.mockClear();
      mockChatRecordingService.recordBranchCheckpointTransaction.mockClear();

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'channel task' }],
          _meta: { [CHANNEL_PROMPT_META_KEY]: true },
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(
        mockChatRecordingService.getBranchCheckpointCursor,
      ).not.toHaveBeenCalled();
      expect(
        mockChatRecordingService.recordBranchCheckpointTransaction,
      ).not.toHaveBeenCalled();
    });

    it('completes the turn when branch checkpoint recording fails', async () => {
      const checkpointError = new Error('checkpoint storage unavailable');
      const cursor = {
        recordId: 'turn-start',
        activeRecordCount: 3,
        pendingToolCalls: [],
      };
      mockChatRecordingService.getBranchCheckpointCursor = vi
        .fn()
        .mockReturnValue(cursor);
      mockChatRecordingService.recordBranchCheckpointTransaction = vi
        .fn()
        .mockRejectedValue(checkpointError);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      debugLoggerWarnSpy.mockClear();

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'complete without a checkpoint' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(
        mockChatRecordingService.recordBranchCheckpointTransaction,
      ).toHaveBeenCalledWith({
        cursor,
        stopReason: 'end_turn',
      });
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        'Failed to record branch checkpoint; completing the turn without a branch point',
        checkpointError,
      );
    });

    it('attaches branch point metadata when checkpoint recording succeeds', async () => {
      const branchPoint = {
        assistantRecordUuid: 'a1b2c3d4-e5f6-1a2b-8c3d-4e5f6a7b8c9d',
        checkpointUuid: 'f9e8d7c6-b5a4-1f2e-9a3b-4c5d6e7f8a9b',
      };
      mockChatRecordingService.getBranchCheckpointCursor = vi
        .fn()
        .mockReturnValue({
          recordId: 'turn-start',
          activeRecordCount: 3,
          pendingToolCalls: [],
        });
      mockChatRecordingService.recordBranchCheckpointTransaction = vi
        .fn()
        .mockResolvedValue(branchPoint);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      const result = await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      expect(result.stopReason).toBe('end_turn');
      expect(result._meta?.['qwen.branchPoint']).toEqual(branchPoint);
    });

    it('installs a trusted daemon context only for the root prompt', async () => {
      const trustedContext: core.InvocationContextV1 = {
        version: 1,
        sessionId: 'test-session-id',
        promptId: 'daemon-prompt-id',
        originatorClientId: 'client-1',
      };
      let observed: core.InvocationContextV1 | undefined;
      mockChat.sendMessageStream = vi.fn().mockImplementation(() => {
        observed = core.getInvocationContext();
        return Promise.resolve(createEmptyStream());
      });

      await session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'trusted prompt' }],
        },
        trustedContext,
      );

      expect(observed).toEqual(trustedContext);
      expect(core.getInvocationContext()).toBeUndefined();
    });

    describe('turn result recording', () => {
      const trustedContext: core.InvocationContextV1 = {
        version: 1,
        sessionId: 'test-session-id',
        promptId: 'daemon-prompt-id',
        originatorClientId: 'client-1',
      };

      it.each([false, true])(
        'records the trusted identity before streaming (display=%s)',
        async (withDisplayText) => {
          let currentPromptId = '';
          mockChat.sendMessageStream = vi.fn().mockImplementation(() => {
            expect(
              mockChatRecordingService.recordUserMessage,
            ).toHaveBeenLastCalledWith(
              'same prompt',
              undefined,
              withDisplayText
                ? { displayText: 'visible prompt', hookContext: '' }
                : undefined,
              expect.stringContaining('test-session-id########'),
              currentPromptId,
            );
            return Promise.resolve(createEmptyStream());
          });
          for (const promptId of ['daemon-first', 'daemon-second']) {
            currentPromptId = promptId;
            await session.prompt(
              {
                sessionId: 'test-session-id',
                prompt: [{ type: 'text', text: 'same prompt' }],
                _meta: {
                  promptId: 'client-supplied-id',
                  ...(withDisplayText
                    ? { 'qwen.daemon.promptDisplayText': 'visible prompt' }
                    : {}),
                },
              },
              { ...trustedContext, promptId },
            );
          }
          expect(
            mockChatRecordingService.recordUserMessage.mock.calls.map(
              (args) => args[4],
            ),
          ).toEqual(['daemon-first', 'daemon-second']);
        },
      );

      it('does not persist a client-supplied identity without a trusted context', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'untrusted identity' }],
          _meta: { promptId: 'client-supplied-id' },
        });
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          'untrusted identity',
          undefined,
          undefined,
          expect.stringContaining('test-session-id########'),
          undefined,
        );
      });

      it('records a completed turn_result for a daemon-admitted prompt', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'trusted prompt' }],
          },
          trustedContext,
        );

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          1,
        );
        const payload =
          mockChatRecordingService.recordTurnResult.mock.calls[0][0];
        expect(payload).toMatchObject({
          promptId: 'daemon-prompt-id',
          state: 'completed',
          stopReason: 'end_turn',
          promptText: 'trusted prompt',
          originatorClientId: 'client-1',
        });
        expect(payload.startedAt).toBeLessThanOrEqual(payload.endedAt);
      });

      it('keeps the settle append on the turn-start recorder across a mid-turn rotation', async () => {
        const rotatedRecordingService: typeof mockChatRecordingService = {
          ...mockChatRecordingService,
          recordTurnResult: vi.fn(),
        };
        let rotated = false;
        vi.mocked(mockConfig.getChatRecordingService).mockImplementation(
          () =>
            (rotated
              ? rotatedRecordingService
              : mockChatRecordingService) as unknown as core.ChatRecordingService,
        );
        mockChat.sendMessageStream = vi.fn().mockImplementation(() => {
          // Simulates a session rotation landing between admission and
          // settle (e.g. `/clear` dispatched as daemon prompt text).
          rotated = true;
          return Promise.resolve(createEmptyStream());
        });

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'trusted prompt' }],
          },
          trustedContext,
        );

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          1,
        );
        expect(rotatedRecordingService.recordTurnResult).not.toHaveBeenCalled();
      });

      it('records daemon display text instead of internal prompt context', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [
              {
                type: 'text',
                text: 'internal channel instructions\n\nhello',
              },
            ],
            _meta: { 'qwen.daemon.promptDisplayText': 'hello' },
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: 'hello',
          }),
        );
      });

      it('records the image placeholder used by the live turn status', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [
              {
                type: 'text',
                text: 'hidden channel instructions',
              },
              {
                type: 'image',
                mimeType: 'image/png',
                data: 'aGVsbG8=',
              },
            ],
            _meta: { 'qwen.daemon.promptDisplayText': '[image]' },
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: '[image]',
          }),
        );
      });

      it('falls back to the prompt extractor when no display text meta is present', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [
              { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            ],
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: '[image]',
          }),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '' }],
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.at(-1)?.[0],
        ).toEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: '',
          }),
        );
      });

      it('treats an empty display text meta as absent for the turn record', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [
              { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            ],
            _meta: { 'qwen.daemon.promptDisplayText': '' },
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: '[image]',
          }),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'projected prompt body' }],
            _meta: { 'qwen.daemon.promptDisplayText': '' },
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.at(-1)?.[0],
        ).toEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            promptText: 'projected prompt body',
          }),
        );
      });

      it('accumulates streamed agent text into resultText', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: 'Hello, ' }] } }],
              },
            },
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: 'world!' }] } }],
              },
            },
          ]),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'greet' }],
          },
          trustedContext,
        );

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            state: 'completed',
            resultText: 'Hello, world!',
          }),
        );
      });

      it('records only the final answer after a tool-call boundary', async () => {
        mockToolRegistry.getTool.mockReturnValue({
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: vi.fn().mockResolvedValue({
              llmContent: 'file contents',
              returnDisplay: 'file contents',
            }),
          }),
        });
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'I will check first. ' }] } },
                  ],
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
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: { parts: [{ text: 'The final answer is 42.' }] },
                    },
                  ],
                },
              },
            ]),
          );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          },
          trustedContext,
        );

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          1,
        );
        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({ resultText: 'The final answer is 42.' }),
        );
      });

      it('excludes subagent updates and leaves resultText absent without a parent answer', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          (async function* () {
            await session.sendUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'x'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS + 1),
              },
              _meta: { parentToolCallId: 'subagent-call' },
            });
            yield* createEmptyStream();
          })(),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'delegate this' }],
          },
          trustedContext,
        );

        const payload =
          mockChatRecordingService.recordTurnResult.mock.calls[0][0];
        expect(payload.resultText).toBeUndefined();
        expect(payload.resultTruncated).toBeUndefined();
      });

      it.each([
        {
          name: 'BMP overflow',
          text: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS + 100),
          expected: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS),
          truncated: true,
        },
        {
          name: 'surrogate pair crossing the cap',
          text: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 1) + '🙂y',
          expected: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 1),
          truncated: true,
        },
        {
          name: 'surrogate pair ending at the cap',
          text: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 2) + '🙂',
          expected: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 2) + '🙂',
          truncated: false,
        },
        {
          name: 'complete surrogate pair before overflow',
          text: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 2) + '🙂y',
          expected: 'a'.repeat(core.TURN_RESULT_TEXT_MAX_CHARS - 2) + '🙂',
          truncated: true,
        },
      ])(
        'caps recorded turn text at TURN_RESULT_TEXT_MAX_CHARS ($name)',
        async ({ text, expected, truncated }) => {
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text }] } }],
                },
              },
            ]),
          );

          await session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text }],
            },
            trustedContext,
          );

          const payload =
            mockChatRecordingService.recordTurnResult.mock.calls[0][0];
          expect(payload.promptText).toBe(expected);
          expect(payload.promptTextTruncated).toBe(
            truncated ? true : undefined,
          );
          expect(payload.resultText).toBe(expected);
          expect(payload.resultTruncated).toBe(truncated ? true : undefined);
          expect(payload.resultCode).toBe(
            truncated ? 'RESULT_TEXT_TRUNCATED' : undefined,
          );
        },
      );

      it('keeps the same surface contract when many chunks exceed the cap', async () => {
        const chunk = 'a'.repeat(
          Math.ceil(core.TURN_RESULT_TEXT_MAX_CHARS / 2),
        );
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
            prompt: [{ type: 'text', text: 'long' }],
          },
          trustedContext,
        );

        const payload =
          mockChatRecordingService.recordTurnResult.mock.calls[0][0];
        expect(payload.resultText).toHaveLength(
          core.TURN_RESULT_TEXT_MAX_CHARS,
        );
        expect(payload.resultTruncated).toBe(true);
        expect(payload.resultCode).toBe('RESULT_TEXT_TRUNCATED');
      });

      it('records a cancelled turn when admission aborts before dispatch', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        let releaseAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        });
        mockConfig.assertCanStartTurn = vi.fn().mockReturnValue(admission);
        const cancellation = new AbortController();

        const prompt = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'cancelled prompt' }],
          },
          trustedContext,
          cancellation.signal,
        );
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledOnce(),
        );
        now = 4_500;
        session.cancelPromptAdmission(cancellation, 'qwen:user-cancel');
        now = 9_500;
        releaseAdmission();

        await expect(prompt).resolves.toMatchObject({
          stopReason: 'cancelled',
          _meta: {
            'qwen.promptCancelled': {
              cancelledAt: 4_500,
              elapsedMs: 0,
            },
          },
        });
        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            state: 'cancelled',
            stopReason: 'cancelled',
            cancelledAt: 4_500,
            cancelReason: 'user',
            endedAt: 9_500,
          }),
        );
      });

      it('records admission errors without a startedAt timestamp', async () => {
        mockConfig.assertCanStartTurn = vi
          .fn()
          .mockRejectedValueOnce(new Error('writer unavailable'));

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'cannot start' }],
            },
            trustedContext,
          ),
        ).rejects.toThrow('writer unavailable');

        const payload =
          mockChatRecordingService.recordTurnResult.mock.calls[0][0];
        expect(payload).toMatchObject({
          promptId: 'daemon-prompt-id',
          state: 'error',
          error: { message: 'writer unavailable' },
        });
        expect(payload.startedAt).toBeUndefined();
      });

      it('records an error turn when the model stream fails', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createFailingStream('model exploded'));

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'boom' }],
            },
            trustedContext,
          ),
        ).rejects.toThrow('model exploded');

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            state: 'error',
            error: { message: 'model exploded' },
          }),
        );
        const errorPayload =
          mockChatRecordingService.recordTurnResult.mock.calls[0][0];
        expect(typeof errorPayload.startedAt).toBe('number');
        expect(errorPayload.startedAt!).toBeLessThanOrEqual(
          errorPayload.endedAt!,
        );
      });

      it('records an error turn for an abort-shaped stream failure without a user cancel', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createFailingStream('Request was aborted.'));

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'abort shaped' }],
            },
            trustedContext,
          ),
        ).rejects.toThrow('Request was aborted.');

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            state: 'error',
          }),
        );
      });

      it('records cancellation time before stream wind-down completes', async () => {
        let now = 1_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createFailingStream('Request was aborted.', () => {
            now = 4_500;
            void session.cancelPendingPrompt();
            now = 9_500;
          }),
        );

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'cancel me' }],
            },
            trustedContext,
          ),
        ).resolves.toMatchObject({
          stopReason: 'cancelled',
          _meta: {
            'qwen.promptCancelled': { cancelledAt: 4_500, elapsedMs: 3_500 },
          },
        });

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            state: 'cancelled',
            startedAt: 1_000,
            cancelledAt: 4_500,
            endedAt: 9_500,
          }),
        );
      });

      it.each(['qwen:user-cancel', 'qwen:prompt-interrupted'])(
        'flushes the durable cancellation record before returning (%s)',
        async (reason) => {
          let releaseFlush!: () => void;
          const flushed = new Promise<void>((resolve) => {
            releaseFlush = resolve;
          });
          mockChatRecordingService.flush.mockReturnValue(flushed);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createFailingStream('Request was aborted.', () => {
              void session.cancelPendingPrompt(reason);
            }),
          );
          let settled = false;
          const prompt = session
            .prompt(
              {
                sessionId: 'test-session-id',
                prompt: [{ type: 'text', text: 'cancel me' }],
              },
              trustedContext,
            )
            .then((response) => {
              settled = true;
              return response;
            });
          await vi.waitFor(() =>
            expect(mockChatRecordingService.flush).toHaveBeenCalled(),
          );
          expect(
            mockChatRecordingService.recordTurnResult.mock.calls.map(
              ([payload]) => payload,
            ),
          ).toContainEqual(expect.objectContaining({ state: 'cancelled' }));
          expect(settled).toBe(false);
          releaseFlush();
          const result = await prompt;
          expect(result.stopReason).toBe('cancelled');
          const payload =
            mockChatRecordingService.recordTurnResult.mock.calls[0][0];
          if (reason === 'qwen:user-cancel') {
            expect(payload).toMatchObject({
              cancelledAt: expect.any(Number),
              cancelReason: 'user',
            });
            expect(result._meta?.['qwen.promptCancelled']).toMatchObject({
              cancelledAt: expect.any(Number),
            });
          } else {
            expect(payload).not.toHaveProperty('cancelledAt');
            expect(payload).not.toHaveProperty('cancelReason');
            expect(result._meta?.['qwen.promptCancelled']).toBeUndefined();
          }
        },
      );

      it('records a cancelled turn when user cancel races a plain stream error', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createFailingStream('model exploded', () => {
            void session.cancelPendingPrompt();
          }),
        );

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'cancel me' }],
            },
            trustedContext,
          ),
        ).resolves.toMatchObject({
          stopReason: 'cancelled',
          _meta: {
            'qwen.promptCancelled': { cancelledAt: expect.any(Number) },
          },
        });

        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            promptId: 'daemon-prompt-id',
            state: 'cancelled',
            stopReason: 'cancelled',
          }),
        );
      });

      it('does not record a turn_result without an invocation context', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'standalone prompt' }],
        });

        expect(
          mockChatRecordingService.recordTurnResult,
        ).not.toHaveBeenCalled();
      });

      it('keeps overlapping turn records attributed to their own promptIds', async () => {
        // DAEMON-003 overlap: the bridge releases the FIFO on deadline
        // while the agent is still executing, so the successor prompt is
        // admitted before the predecessor settles. Each turn must still
        // settle its own record under its own promptId.
        mockConfig.assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstStream = (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'first answer' }] } }],
            },
          };
          await firstBlocked;
        })();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(firstStream)
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'second answer' }] } },
                  ],
                },
              },
            ]),
          );

        const first = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first prompt' }],
          },
          trustedContext,
        );
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1),
        );

        const secondContext: core.InvocationContextV1 = {
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'second-prompt-id',
          originatorClientId: 'client-1',
        };
        const second = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second prompt' }],
          },
          secondContext,
        );
        // Third assertCanStartTurn call = the successor's prompt()-level
        // admission (turn A used the prompt + inner calls). Flush
        // microtasks so the successor's recording begin has run.
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledTimes(3),
        );
        await Promise.resolve();
        await Promise.resolve();

        releaseFirst();
        await first;
        await second;

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          2,
        );
        const payloads =
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            (call) => call[0],
          );
        const firstPayload = payloads.find(
          (payload) => payload.promptId === 'daemon-prompt-id',
        );
        const secondPayload = payloads.find(
          (payload) => payload.promptId === 'second-prompt-id',
        );
        expect(firstPayload).toMatchObject({
          promptId: 'daemon-prompt-id',
          state: 'cancelled',
          promptText: 'first prompt',
          resultText: 'first answer',
        });
        expect(secondPayload).toMatchObject({
          promptId: 'second-prompt-id',
          state: 'completed',
          promptText: 'second prompt',
          resultText: 'second answer',
        });
      });

      it('records a superseded turn as cancelled when its stream throws the abort', async () => {
        mockConfig.assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
        let rejectFirst!: (error: unknown) => void;
        const firstFailure = new Promise<never>((_resolve, reject) => {
          rejectFirst = reject;
        });
        const firstStream = (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'partial' }] } }],
            },
          };
          await firstFailure;
        })();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(firstStream)
          .mockResolvedValueOnce(createEmptyStream());

        const first = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first prompt' }],
          },
          trustedContext,
        );
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1),
        );

        const second = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second prompt' }],
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'second-prompt-id',
          },
        );
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledTimes(3),
        );
        rejectFirst(
          new DOMException('superseded stream aborted', 'AbortError'),
        );

        const [firstResult, secondResult] = await Promise.allSettled([
          first,
          second,
        ]);
        expect(firstResult).toEqual({
          status: 'fulfilled',
          value: { stopReason: 'cancelled' },
        });
        expect(secondResult.status).toBe('fulfilled');

        const firstPayload =
          mockChatRecordingService.recordTurnResult.mock.calls
            .map((call) => call[0])
            .find((payload) => payload.promptId === 'daemon-prompt-id');
        expect(firstPayload).toMatchObject({
          state: 'cancelled',
          stopReason: 'cancelled',
          promptText: 'first prompt',
        });
        expect(firstPayload).not.toHaveProperty('cancelledAt');
        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          2,
        );
        const secondPayload =
          mockChatRecordingService.recordTurnResult.mock.calls
            .map((call) => call[0])
            .find((payload) => payload.promptId === 'second-prompt-id');
        expect(secondPayload).toMatchObject({
          promptId: 'second-prompt-id',
          state: 'completed',
        });
      });

      it('surfaces a genuine failure after a successor abort instead of cancelling', async () => {
        mockConfig.assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
        let rejectFirst!: (error: unknown) => void;
        const firstFailure = new Promise<never>((_resolve, reject) => {
          rejectFirst = reject;
        });
        const firstStream = (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'partial' }] } }],
            },
          };
          await firstFailure;
        })();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(firstStream)
          .mockResolvedValueOnce(createEmptyStream());

        const first = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first prompt' }],
          },
          trustedContext,
        );
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1),
        );

        const second = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second prompt' }],
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'second-prompt-id',
          },
        );
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledTimes(3),
        );
        const genuineFailure = new Error('model backend failed');
        rejectFirst(genuineFailure);

        const [firstResult, secondResult] = await Promise.allSettled([
          first,
          second,
        ]);
        expect(firstResult).toEqual({
          status: 'rejected',
          reason: genuineFailure,
        });
        expect(secondResult.status).toBe('fulfilled');

        const firstPayload =
          mockChatRecordingService.recordTurnResult.mock.calls
            .map((call) => call[0])
            .find((payload) => payload.promptId === 'daemon-prompt-id');
        expect(firstPayload).toMatchObject({
          promptId: 'daemon-prompt-id',
          state: 'error',
          promptText: 'first prompt',
        });
        const secondPayload =
          mockChatRecordingService.recordTurnResult.mock.calls
            .map((call) => call[0])
            .find((payload) => payload.promptId === 'second-prompt-id');
        expect(secondPayload).toMatchObject({
          promptId: 'second-prompt-id',
          state: 'completed',
        });
      });

      it('records a cancelled turn when cancelled while waiting for the predecessor', async () => {
        // The successor is admitted while the predecessor still streams,
        // then cancelled during the predecessor wait; it must settle its
        // own cancelled record without disturbing the predecessor's.
        mockConfig.assertCanStartTurn = vi.fn().mockResolvedValue(undefined);
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const firstStream = (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [] } }],
            },
          };
          await firstBlocked;
        })();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(firstStream)
          .mockResolvedValueOnce(createEmptyStream());

        const first = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first prompt' }],
          },
          trustedContext,
        );
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1),
        );

        const secondContext: core.InvocationContextV1 = {
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'second-prompt-id',
        };
        const admissionCancellation = new AbortController();
        const second = session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second prompt' }],
          },
          secondContext,
          admissionCancellation.signal,
        );
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledTimes(3),
        );
        await Promise.resolve();
        await Promise.resolve();
        session.cancelPromptAdmission(
          admissionCancellation,
          'qwen:user-cancel',
        );

        releaseFirst();
        await first;
        await expect(second).resolves.toMatchObject({
          stopReason: 'cancelled',
          _meta: {
            'qwen.promptCancelled': {
              cancelledAt: expect.any(Number),
              elapsedMs: 0,
            },
          },
        });

        expect(mockChatRecordingService.recordTurnResult).toHaveBeenCalledTimes(
          2,
        );
        const payloads =
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            (call) => call[0],
          );
        const firstPayload = payloads.find(
          (payload) => payload.promptId === 'daemon-prompt-id',
        );
        const secondPayload = payloads.find(
          (payload) => payload.promptId === 'second-prompt-id',
        );
        expect(firstPayload).toMatchObject({
          promptId: 'daemon-prompt-id',
          promptText: 'first prompt',
        });
        expect(secondPayload).toMatchObject({
          promptId: 'second-prompt-id',
          state: 'cancelled',
          stopReason: 'cancelled',
          promptText: 'second prompt',
        });
      });
    });

    it('rejects a trusted context for a different session', async () => {
      const trustedContext: core.InvocationContextV1 = {
        version: 1,
        sessionId: 'different-session',
        promptId: 'daemon-prompt-id',
      };

      await expect(
        session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'mismatched prompt' }],
          },
          trustedContext,
        ),
      ).rejects.toThrow(
        'Invocation context session does not match the active session',
      );
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordTurnResult).not.toHaveBeenCalled();
    });

    it('does not create invocation context for standalone ACP prompts', async () => {
      let observed: core.InvocationContextV1 | undefined;
      mockChat.sendMessageStream = vi.fn().mockImplementation(() => {
        observed = core.getInvocationContext();
        return Promise.resolve(createEmptyStream());
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'standalone prompt' }],
      });

      expect(observed).toBeUndefined();
    });

    it('uses a trusted model-only prompt while recording the public prompt', async () => {
      const trustedContext: core.InvocationContextV1 = {
        version: 1,
        sessionId: 'test-session-id',
        promptId: 'daemon-prompt-id',
      };
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '原始语音文本' }],
        },
        trustedContext,
        undefined,
        '<realtime_delegation>trusted model input</realtime_delegation>',
      );

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        '原始语音文本',
        undefined,
        undefined,
        expect.stringContaining('test-session-id########'),
        trustedContext.promptId,
      );
      expect(textParts(firstSentMessage())).toEqual([
        '<realtime_delegation>trusted model input</realtime_delegation>',
      ]);
    });

    it.each([
      ['file', '@README.md'],
      ['mcp', '@mcp:o2'],
      ['extension', '@ext:browser'],
    ])('records %s input annotations for replay', async (kind, text) => {
      const inputAnnotations = [
        {
          type: 'reference',
          start: 0,
          end: text.length,
          text,
          reference: { id: text, kind, value: text.slice(1), serialized: text },
        },
      ];
      const expectedAnnotations = structuredClone(inputAnnotations);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text }],
          _meta: {
            [DAEMON_INPUT_ANNOTATIONS_META_KEY]: inputAnnotations,
            privateRequestId: 'not-for-history',
          },
        },
        { version: 1, sessionId: 'test-session-id', promptId: 'tag-prompt' },
        undefined,
        'model-only prompt',
      );
      inputAnnotations[0].reference.value = 'changed after submission';

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        text,
        undefined,
        {
          displayText: text,
          hookContext: '',
          inputAnnotations: expectedAnnotations,
        },
        expect.stringContaining('test-session-id########'),
        'tag-prompt',
      );
      expect(textParts(firstSentMessage())).toEqual(['model-only prompt']);
    });

    it.each([null, 'invalid', {}, [], [null], ['x'], [[null]]])(
      'ignores invalid or empty input annotations (%j)',
      async (inputAnnotations) => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
          _meta: { inputAnnotations },
        });
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          'hello',
          undefined,
          undefined,
          expect.stringContaining('test-session-id########'),
          undefined,
        );
      },
    );

    it('drops non-object elements from input annotations', async () => {
      const valid = {
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: 'file:hello', kind: 'file', value: 'hello' },
      };
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: { [DAEMON_INPUT_ANNOTATIONS_META_KEY]: [null, 'x', valid] },
      });
      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        {
          displayText: 'hello',
          hookContext: '',
          inputAnnotations: [valid],
        },
        expect.stringContaining('test-session-id########'),
        undefined,
      );
    });

    it('ignores input annotations beyond the daemon cap', async () => {
      const inputAnnotations = Array.from({ length: 257 }, (_, i) => ({
        type: 'reference',
        start: 0,
        end: 5,
        text: 'hello',
        reference: { id: `ref-${i}`, kind: 'file', value: `f${i}` },
      }));
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hello' }],
        _meta: { [DAEMON_INPUT_ANNOTATIONS_META_KEY]: inputAnnotations },
      });
      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'hello',
        undefined,
        undefined,
        expect.stringContaining('test-session-id########'),
        undefined,
      );
    });

    it.each(['read both', ''])(
      'records original resource links independently of model expansion (%j)',
      async (text) => {
        const links = [
          {
            type: 'resource_link' as const,
            uri: 'transit://resource-a',
            name: 'notes.md',
            mimeType: 'text/markdown',
            size: 0,
            title: 'First notes',
            description: 'Original reference',
            annotations: { audience: ['user' as const], priority: 0.5 },
            _meta: { preview: { version: 1 } },
          },
          {
            type: 'resource_link' as const,
            uri: 'https://example.com/notes.md',
            name: 'notes.md',
          },
        ];
        const expectedLinks = structuredClone(links);
        const trustedContext: core.InvocationContextV1 = {
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'resource-prompt',
        };
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [
              ...(text ? [{ type: 'text' as const, text }] : []),
              ...links,
            ],
          },
          trustedContext,
          undefined,
          'model-only instruction',
        );
        links[0]._meta!.preview.version = 2;

        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          text,
          undefined,
          {
            displayText: text,
            hookContext: '',
            resourceLinks: expectedLinks,
          },
          expect.stringContaining('test-session-id########'),
          trustedContext.promptId,
        );
        expect(textParts(firstSentMessage())).toEqual([
          'model-only instruction',
        ]);
      },
    );

    it.each(['image', 'text', 'binary'] as const)(
      'keeps %s attachment paths in model context without changing user display text',
      async (kind) => {
        const context = 'Attachment absolutePath: /tmp/attached-file';
        const reference = {
          type: kind === 'image' ? 'image' : 'resource',
          attachmentId: kind === 'image' ? 'image.png' : 'file.txt',
          mimeType: kind === 'image' ? 'image/png' : 'text/plain',
          size: 3,
        };
        const attachment: PromptRequest['prompt'][number] =
          kind === 'image'
            ? { type: 'image', data: 'AQID', mimeType: 'image/png' }
            : {
                type: 'resource',
                resource: {
                  uri: 'attachment:///file.txt',
                  mimeType: 'text/plain',
                  ...(kind === 'text'
                    ? { text: 'contents' }
                    : { blob: 'AP8B' }),
                },
              };
        attachment._meta = { 'qwen.daemon.attachmentContext': context };
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        // The image case has no user text or resource block to avoid either
        // image-only early return hiding the model context.
        const userText = kind === 'image' ? '' : 'inspect this';
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [
            ...(userText ? [{ type: 'text' as const, text: userText }] : []),
            attachment,
          ],
          _meta: { 'qwen.daemon.attachmentReferences': [reference] },
        });

        expect(firstSentMessage()).toContainEqual({ text: context });
        if (kind === 'image') {
          expect(firstSentMessage()).toContainEqual({
            inlineData: { data: 'AQID', mimeType: 'image/png' },
          });
        }
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          userText,
          undefined,
          expect.objectContaining({
            displayText: userText,
            attachmentReferences: [reference],
          }),
          expect.any(String),
          undefined,
        );
      },
    );

    it('records daemon attachment references for transcript replay', async () => {
      const imageReference = {
        type: 'image' as const,
        attachmentId: 'image.png',
        mimeType: 'image/png',
        size: 3,
      };
      const fileReference = {
        type: 'resource' as const,
        attachmentId: 'notes.json',
        mimeType: 'application/json',
        size: 6,
      };
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          { type: 'text', text: 'describe this' },
          { type: 'image', data: 'AQID', mimeType: 'image/png' },
          {
            type: 'resource',
            resource: {
              uri: 'attachment:///notes.json',
              mimeType: 'application/json',
              text: '你好',
            },
          },
        ],
        _meta: {
          'qwen.daemon.attachmentReferences': [imageReference, fileReference],
        },
      });

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'describe this',
        undefined,
        {
          displayText: 'describe this',
          hookContext: '',
          attachmentReferences: [imageReference, fileReference],
        },
        expect.stringContaining('test-session-id########'),
        undefined,
      );
    });

    it('records 256 attachment references from one prompt', async () => {
      const attachmentReferences = Array.from({ length: 256 }, (_, index) => ({
        type: 'image' as const,
        attachmentId: `media-${index}`,
        mimeType: 'image/png',
        size: 3,
      }));
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'describe these' }],
        _meta: {
          'qwen.daemon.attachmentReferences': attachmentReferences,
        },
      });

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'describe these',
        undefined,
        expect.objectContaining({ attachmentReferences }),
        expect.stringContaining('test-session-id########'),
        undefined,
      );
    });

    it('records empty file attachment references', async () => {
      const attachmentReference = {
        type: 'resource' as const,
        attachmentId: 'empty.txt',
        mimeType: 'text/plain',
        size: 0,
      };
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect this' }],
        _meta: {
          'qwen.daemon.attachmentReferences': [attachmentReference],
        },
      });

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        'inspect this',
        undefined,
        expect.objectContaining({
          attachmentReferences: [attachmentReference],
        }),
        expect.stringContaining('test-session-id########'),
        undefined,
      );
    });

    it('rejects model-only prompts without trusted invocation context', async () => {
      await expect(
        session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'public prompt' }],
          },
          undefined,
          undefined,
          'forged model prompt',
        ),
      ).rejects.toThrow(
        'Model-only prompt requires trusted invocation context',
      );
      expect(mockChatRecordingService.recordUserMessage).not.toHaveBeenCalled();
      expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
    });

    it('clears the root invocation context from automatic turns', async () => {
      const rootContext: core.InvocationContextV1 = {
        version: 1,
        sessionId: 'test-session-id',
        promptId: 'root-prompt-id',
      };
      let cronCallback: ((job: { prompt: string }) => void) | undefined;
      const scheduler = {
        size: 1,
        hasPendingWork: true,
        start: vi.fn((callback: (job: { prompt: string }) => void) => {
          cronCallback = callback;
        }),
        stop: vi.fn(),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      const observed: Array<core.InvocationContextV1 | undefined> = [];
      mockChat.sendMessageStream = vi.fn().mockImplementation(() => {
        observed.push(core.getInvocationContext());
        return Promise.resolve(createEmptyStream());
      });
      const internals = session as unknown as {
        cronCompletion: Promise<void> | null;
        notificationCompletion: Promise<void> | null;
      };

      await session.prompt(
        {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'root prompt' }],
        },
        rootContext,
      );

      expect(observed).toEqual([rootContext]);

      await core.runWithInvocationContext(rootContext, async () => {
        cronCallback?.({ prompt: 'scheduled prompt' });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });
        await vi.waitFor(() => {
          expect(internals.cronCompletion).toBeNull();
        });
      });

      const backgroundCallback = mockBackgroundTaskRegistry
        .setNotificationCallback.mock.calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { agentId: string; status: string; toolUseId?: string },
      ) => void;
      await core.runWithInvocationContext(rootContext, async () => {
        backgroundCallback('done', '<task-notification />', {
          agentId: 'agent-1',
          status: 'completed',
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        });
        await vi.waitFor(() => {
          expect(internals.notificationCompletion).toBeNull();
        });
      });

      expect(observed).toEqual([rootContext, undefined, undefined]);
    });

    it('resets per-turn memory state on every cron-fired prompt', async () => {
      let cronCallback: ((job: { prompt: string }) => void) | undefined;
      const scheduler = {
        size: 1,
        hasPendingWork: true,
        start: vi.fn((callback: (job: { prompt: string }) => void) => {
          cronCallback = callback;
        }),
        stop: vi.fn(),
        getExitSummary: vi.fn().mockReturnValue(undefined),
      };
      mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
      mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
      mockChat.sendMessageStream = vi
        .fn()
        .mockImplementation(() => Promise.resolve(createEmptyStream()));
      const internals = session as unknown as {
        cronCompletion: Promise<void> | null;
      };

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'root prompt' }],
      });
      const resetsAfterUserTurn =
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn.mock.calls
          .length;

      cronCallback?.({ prompt: 'scheduled prompt' });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(internals.cronCompletion).toBeNull();
      });
      cronCallback?.({ prompt: 'scheduled prompt again' });
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
      });
      await vi.waitFor(() => {
        expect(internals.cronCompletion).toBeNull();
      });

      expect(
        mockMemoryManager.resetExhaustedBodyRefsForCurrentTurn.mock.calls
          .length,
      ).toBe(resetsAfterUserTurn + 2);
    });

    it('records the latest file history snapshot after makeSnapshot', async () => {
      const latestSnapshot = {
        promptId: 'test-session-id########1',
        timestamp: new Date('2026-06-13T00:00:00.000Z'),
        trackedFileBackups: {
          'a.txt': {
            backupFileName: 'backup-a',
            version: 1,
            backupTime: new Date('2026-06-13T00:00:01.000Z'),
          },
        },
      };
      mockFileHistoryService.getSnapshots.mockReturnValue([latestSnapshot]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'edit file' }],
      });

      expect(mockFileHistoryService.makeSnapshot).toHaveBeenCalledWith(
        'test-session-id########1',
      );
      expect(
        mockChatRecordingService.recordFileHistorySnapshot,
      ).toHaveBeenCalledWith(latestSnapshot);
    });

    it('fires MessageDisplay with cumulative non-thought text and is_final on the ACP prompt path', async () => {
      // Regression: the ACP surface consumes LlmChat's stream directly
      // (never entering LlmClient.sendMessageStream), so it must fire the
      // MessageDisplay hook itself — without this, an IDE/daemon client sees
      // the hook advertised but never receives an event.
      const messageBus = { request: vi.fn().mockResolvedValue({}) };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi
        .fn()
        .mockImplementation((event: string) => event === 'MessageDisplay');
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: 'Let me think...', thought: true },
                      { text: 'Hello, ' },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'world.' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      const messageDisplayCalls = messageBus.request.mock.calls.filter(
        ([request]) => request.eventName === 'MessageDisplay',
      );
      expect(messageDisplayCalls.length).toBeGreaterThan(0);
      const finalCall = messageDisplayCalls[messageDisplayCalls.length - 1][0];
      // Cumulative text of the displayed (non-thought) parts only.
      expect(finalCall.input).toMatchObject({
        displayed_text: 'Hello, world.',
        is_final: true,
      });
      expect(finalCall.input.message_id).toEqual(expect.any(String));
      // Exactly one is_final firing for the message.
      expect(
        messageDisplayCalls.filter(([request]) => request.input.is_final),
      ).toHaveLength(1);
    });

    it('does not fire MessageDisplay on the ACP prompt path when the hook is not registered', async () => {
      const messageBus = { request: vi.fn().mockResolvedValue({}) };
      mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(false);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'Hello.' }] } }],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'hi' }],
      });

      expect(messageBus.request).not.toHaveBeenCalled();
    });

    describe('per_task channel output', () => {
      afterEach(async () => {
        session.dispose();
        await vi.waitFor(() => {
          expect(
            (session as unknown as { channelTaskCaptures: Set<unknown> })
              .channelTaskCaptures.size,
          ).toBe(0);
        });
      });
      const workChainId = 'test-session-id########1';
      const taskPrompt: PromptRequest = {
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start background work' }],
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_OUTPUT_MODE_META_KEY]: 'per_task',
        },
      };
      const textStream = (text: string) =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text }] } }],
            },
          },
        ]);
      const emitNotification = (
        kind: 'agent' | 'shell' | 'monitor' | 'workflow',
        taskId: string,
        chainId = workChainId,
        status: 'completed' | 'cancelled' = 'completed',
      ) => {
        const registry = {
          agent: mockBackgroundTaskRegistry,
          shell: mockBackgroundShellRegistry,
          monitor: mockMonitorRegistry,
          workflow: mockWorkflowRunRegistry,
        }[kind];
        const callback =
          'setCompletionCallback' in registry
            ? registry.setCompletionCallback.mock.calls[0][0]
            : registry.setNotificationCallback.mock.calls[0][0];
        const idField = {
          agent: 'agentId',
          shell: 'shellId',
          monitor: 'monitorId',
          workflow: 'runId',
        }[kind];
        callback('done', '<task-notification />', {
          [idField]: taskId,
          status,
          todoWorkChainId: chainId,
        });
      };
      const expectMainReleased = async () => {
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          expect(
            (session as unknown as { pendingPromptCompletion: unknown })
              .pendingPromptCompletion,
          ).toBeNull();
        });
      };

      it('honors cancellation for a locally handled command without a work chain', async () => {
        const cancellation = new AbortController();
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(async () => {
          cancellation.abort();
          return {
            type: 'message',
            messageType: 'info',
            content: 'Already compressed.',
          };
        });

        const result = await session.prompt(
          {
            ...taskPrompt,
            prompt: [{ type: 'text', text: '/compress' }],
          },
          undefined,
          cancellation.signal,
        );

        expect(result.stopReason).toBe('cancelled');
        expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
        expect(mockConfig.startActiveTodoWorkChain).not.toHaveBeenCalled();
      });

      it('does not wait for unowned work after a locally handled command', async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          { id: 'unowned-agent', status: 'running', isBackgrounded: true },
        ]);
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'info',
          content: 'Already compressed.',
        });
        let result: Awaited<ReturnType<Session['prompt']>> | undefined;
        const resultPromise = session
          .prompt({
            ...taskPrompt,
            prompt: [{ type: 'text', text: '/compress' }],
          })
          .then((value) => {
            result = value;
          });
        try {
          await vi.waitFor(() => expect(result).toBeDefined());
          expect(result?.stopReason).toBe('end_turn');
          expect(result?._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
          expect(mockConfig.startActiveTodoWorkChain).not.toHaveBeenCalled();
        } finally {
          session.dispose();
          await resultPromise;
        }
      });

      it.each([
        ['agent', 'running'],
        ['agent', 'paused'],
        ['agent', 'cancelled'],
        ['shell', 'running'],
        ['monitor', 'running'],
        ['workflow', 'running'],
        ['workflow', 'pausing'],
        ['workflow', 'paused'],
      ] as const)(
        'waits for a related %s in %s state and its notification response without locking the drain',
        async (kind, status) => {
          const task = {
            id: 'background-1',
            description: 'Background task',
            todoWorkChainId: workChainId,
            status: status as string,
            isBackgrounded: true,
            notified: false,
          };
          const list = {
            agent: mockBackgroundTaskRegistry.getAll,
            shell: mockBackgroundShellRegistry.getAll,
            monitor: mockMonitorRegistry.getAll,
            workflow: mockWorkflowRunRegistry.list,
          }[kind];
          list.mockReturnValue([task]);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(textStream('Main result'))
            .mockResolvedValueOnce(textStream('Background final'));
          let settled = false;
          const resultPromise = session.prompt(taskPrompt).then((result) => {
            settled = true;
            return result;
          });
          await expectMainReleased();
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(settled).toBe(false);

          const terminalStatus =
            status === 'cancelled' ? 'cancelled' : 'completed';
          task.status = terminalStatus;
          task.notified = true;
          emitNotification(kind, task.id, workChainId, terminalStatus);
          await vi.waitFor(() => expect(settled).toBe(true));
          const result = await resultPromise;

          expect(result).toMatchObject({
            stopReason: 'end_turn',
            _meta: { [CHANNEL_TASK_RESULT_META_KEY]: 'Background final' },
          });
          const response = vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.find(
              ([params]) =>
                params.update.sessionUpdate === 'agent_message_chunk' &&
                params.update.content.type === 'text' &&
                params.update.content.text === 'Background final',
            );
          expect(response?.[0].update._meta).toMatchObject({
            source: 'background_notification_response',
            [CHANNEL_TASK_OUTPUT_META_KEY]: true,
          });
        },
      );

      it('waits for the last related notification after its queue and registry drain', async () => {
        const task = {
          id: 'agent-last',
          description: 'Last task',
          status: 'running',
          todoWorkChainId: workChainId,
          isBackgrounded: true,
          notified: false,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockImplementationOnce(async () => {
            await gate;
            return textStream('Last background result');
          });
        let result: Awaited<ReturnType<Session['prompt']>> | undefined;
        const resultPromise = session.prompt(taskPrompt).then((value) => {
          result = value;
        });
        try {
          await expectMainReleased();
          task.status = 'completed';
          task.notified = true;
          emitNotification('agent', task.id);
          await vi.waitFor(() =>
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
          );
          const internals = session as unknown as {
            notificationQueue: unknown[];
            channelTaskCaptures: Set<unknown>;
          };
          expect(internals.notificationQueue).toHaveLength(0);
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(result).toBeUndefined();
          expect(internals.channelTaskCaptures.size).toBe(1);
          release();
          await resultPromise;
          expect(result?._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
            'Last background result',
          );
        } finally {
          release();
          session.dispose();
          await resultPromise;
        }
      });

      it('returns max_tokens without waiting for related background work', async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'agent-running',
            status: 'running',
            isBackgrounded: true,
            todoWorkChainId: workChainId,
          },
        ]);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 101,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        let result: Awaited<ReturnType<Session['prompt']>> | undefined;
        const resultPromise = session.prompt(taskPrompt).then((value) => {
          result = value;
        });
        try {
          await vi.waitFor(() => expect(result).toBeDefined());
          expect(result?.stopReason).toBe('max_tokens');
          expect(result?._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
          expect(
            (session as unknown as { channelTaskCaptures: Set<unknown> })
              .channelTaskCaptures.size,
          ).toBe(0);
        } finally {
          session.dispose();
          await resultPromise;
        }
      });

      it('preserves a per_task result across a temporary close gate', async () => {
        const task = {
          id: 'agent-1',
          description: 'Related background task',
          status: 'running',
          isBackgrounded: true,
          notified: false,
          todoWorkChainId: workChainId,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockResolvedValueOnce(textStream('Background final'));
        let settled = false;
        const resultPromise = session.prompt(taskPrompt).then((result) => {
          settled = true;
          return result;
        });
        await expectMainReleased();
        const releaseGate = session.beginClose();
        try {
          let drained = false;
          const drain = session.waitForActiveTurnsToSettle().then(() => {
            drained = true;
          });
          await vi.waitFor(() => expect(drained).toBe(true));
          await drain;
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(settled).toBe(false);
          task.status = 'completed';
          task.notified = true;
          emitNotification('agent', task.id);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          releaseGate();
          expect(await resultPromise).toMatchObject({
            stopReason: 'end_turn',
            _meta: { [CHANNEL_TASK_RESULT_META_KEY]: 'Background final' },
          });
        } finally {
          releaseGate();
          session.dispose();
          await resultPromise;
        }
      });

      it('keeps history mutations busy while a per_task result is pending', async () => {
        const task = {
          id: 'agent-1',
          status: 'running',
          isBackgrounded: true,
          notified: false,
          todoWorkChainId: workChainId,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(textStream('Main result'));
        const resultPromise = session.prompt(taskPrompt);
        try {
          await expectMainReleased();
          expect(session.isTurnIdle()).toBe(false);
          expect(() => session.beginHistoryMutation()).toThrow(
            'Session is busy processing a turn',
          );
          expect(() => session.rewindToTurn(0)).toThrow(
            'Cannot rewind while a prompt is running',
          );
          expect(() => session.restoreHistory([])).toThrow(
            'Cannot restore history while a prompt is running',
          );
          task.status = 'completed';
          task.notified = true;
          await resultPromise;
          expect(session.isTurnIdle()).toBe(true);
          session.beginHistoryMutation()();
        } finally {
          session.dispose();
          await resultPromise;
        }
      });

      it('waits for an in-flight notification and keeps only its latest non-empty response', async () => {
        const task = {
          id: 'agent-1',
          description: 'Background task',
          todoWorkChainId: workChainId,
          status: 'running',
          isBackgrounded: true,
          notified: false,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        let finishLast!: () => void;
        const last = new Promise<void>((resolve) => {
          finishLast = resolve;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockResolvedValueOnce(textStream('Earlier callback result'))
          .mockImplementationOnce(async () => {
            await last;
            return textStream('Final callback result');
          })
          .mockResolvedValueOnce(textStream('  '));
        let settled = false;
        const resultPromise = session.prompt(taskPrompt).then((result) => {
          settled = true;
          return result;
        });
        await expectMainReleased();
        task.status = 'completed';
        task.notified = true;
        emitNotification('agent', 'agent-1');
        emitNotification('agent', 'agent-2');
        emitNotification('agent', 'agent-3');
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        });
        expect(settled).toBe(false);
        finishLast();
        const result = await resultPromise;
        expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
          'Final callback result',
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4);
      });

      it('keeps waiting when a notification creates another related background task', async () => {
        const first = {
          id: 'agent-1',
          description: 'Background task',
          todoWorkChainId: workChainId,
          status: 'running',
          isBackgrounded: true,
          notified: false,
        };
        const nested = { ...first, id: 'agent-2' };
        const tasks = [first];
        mockBackgroundTaskRegistry.getAll.mockImplementation(() => tasks);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockImplementationOnce(async () => {
            tasks.push(nested);
            return textStream('Spawned follow-up work');
          })
          .mockResolvedValueOnce(textStream('Nested final'));
        let settled = false;
        const resultPromise = session.prompt(taskPrompt).then((result) => {
          settled = true;
          return result;
        });
        await expectMainReleased();
        first.status = 'completed';
        first.notified = true;
        emitNotification('agent', first.id);
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });
        expect(settled).toBe(false);
        nested.status = 'completed';
        nested.notified = true;
        emitNotification('agent', nested.id);
        expect(
          (await resultPromise)._meta?.[CHANNEL_TASK_RESULT_META_KEY],
        ).toBe('Nested final');
      });

      it.each(['agent', 'shell'] as const)(
        'follows real %s registry completion through the notification drain',
        async (kind) => {
          session.dispose();
          const directory = fsSync.mkdtempSync(
            path.join(os.tmpdir(), 'qwen-channel-task-'),
          );
          const agents = new core.BackgroundTaskRegistry();
          const shells = new core.BackgroundShellRegistry();
          vi.mocked(mockConfig.getBackgroundTaskRegistry).mockReturnValue(
            agents,
          );
          vi.mocked(mockConfig.getBackgroundShellRegistry).mockReturnValue(
            shells,
          );
          session = new Session(
            'test-session-id',
            mockConfig,
            mockClient,
            mockSettings,
          );
          let registered!: core.AgentTask | core.ShellTask;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () => {
              const common = {
                status: 'running' as const,
                startTime: Date.now(),
                abortController: new AbortController(),
                todoWorkChainId: workChainId,
              };
              registered =
                kind === 'agent'
                  ? agents.register({
                      ...common,
                      agentId: 'actual-agent',
                      description: 'Actual background agent',
                      isBackgrounded: true,
                      outputFile: path.join(directory, 'agent.jsonl'),
                    })
                  : shells.register({
                      ...common,
                      shellId: 'actual-shell',
                      command: 'already-running-test-command',
                      cwd: directory,
                      outputPath: path.join(directory, 'shell.output'),
                    });
              return textStream('Main final');
            })
            .mockResolvedValueOnce(textStream('Actual callback final'));
          const resultPromise = session.prompt(taskPrompt);
          try {
            await expectMainReleased();
            expect(registered.notified).toBe(false);
            if (kind === 'agent') agents.complete('actual-agent', 'done');
            else shells.complete('actual-shell', 0, Date.now());
            expect(registered.status).toBe('completed');
            expect(registered.notified).toBe(true);
            const result = await resultPromise;
            expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
              'Actual callback final',
            );
            expect(
              mockChatRecordingService.recordNotification,
            ).toHaveBeenCalled();
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          } finally {
            session.dispose();
            await resultPromise;
            fsSync.rmSync(directory, { recursive: true, force: true });
          }
        },
      );

      it('keeps overlapping user prompts associated with their own task chains', async () => {
        const first = {
          id: 'agent-1',
          description: 'First task',
          todoWorkChainId: workChainId,
          status: 'running',
          isBackgrounded: true,
          notified: false,
        };
        const second = {
          ...first,
          id: 'agent-2',
          todoWorkChainId: 'test-session-id########2',
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([first, second]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('First main'))
          .mockResolvedValueOnce(textStream('Second main'))
          .mockResolvedValueOnce(textStream('First task final'))
          .mockResolvedValueOnce(textStream('Second task final'));
        const firstResult = session.prompt(taskPrompt);
        await expectMainReleased();
        let secondSettled = false;
        const secondResult = session.prompt(taskPrompt).then((result) => {
          secondSettled = true;
          return result;
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(
            (session as unknown as { pendingPromptCompletion: unknown })
              .pendingPromptCompletion,
          ).toBeNull();
        });
        first.status = 'completed';
        first.notified = true;
        emitNotification('agent', first.id);
        expect((await firstResult)._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
          'First task final',
        );
        expect(secondSettled).toBe(false);
        second.status = 'completed';
        second.notified = true;
        emitNotification('agent', second.id, second.todoWorkChainId);
        expect((await secondResult)._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
          'Second task final',
        );
      });

      it('does not return a captured background result after cancellation', async () => {
        const first = {
          id: 'agent-1',
          description: 'First task',
          todoWorkChainId: workChainId,
          status: 'running',
          isBackgrounded: true,
          notified: false,
        };
        const second = { ...first, id: 'agent-2' };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([first, second]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockResolvedValueOnce(textStream('Earlier background result'))
          .mockResolvedValueOnce(textStream('Late background result'));
        const cancellation = new AbortController();
        const resultPromise = session.prompt(
          taskPrompt,
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'cancelled-task',
          },
          cancellation.signal,
        );
        await expectMainReleased();
        first.status = 'completed';
        first.notified = true;
        emitNotification('agent', first.id);
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({
                content: { type: 'text', text: 'Earlier background result' },
                _meta: expect.objectContaining({
                  [CHANNEL_TASK_OUTPUT_META_KEY]: true,
                }),
              }),
            }),
          );
        });
        let releaseFlush!: () => void;
        mockChatRecordingService.flush.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseFlush = resolve;
            }),
        );
        try {
          cancellation.abort();
          await vi.waitFor(() => expect(releaseFlush).toBeDefined());
          expect(
            (session as unknown as { channelTaskCaptures: Set<unknown> })
              .channelTaskCaptures.size,
          ).toBe(1);
          second.status = 'completed';
          second.notified = true;
          emitNotification('agent', second.id);
          await vi.waitFor(() => {
            const response = vi
              .mocked(mockClient.sessionUpdate)
              .mock.calls.map(([params]) => params.update)
              .find(
                (update) =>
                  update.sessionUpdate === 'agent_message_chunk' &&
                  update.content.type === 'text' &&
                  update.content.text === 'Late background result',
              );
            expect(response).toBeDefined();
            expect(
              response?._meta?.[CHANNEL_TASK_OUTPUT_META_KEY],
            ).toBeUndefined();
          });
          releaseFlush();
          const result = await resultPromise;
          expect(result.stopReason).toBe('cancelled');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
        } finally {
          releaseFlush?.();
          session.dispose();
          await resultPromise;
        }
      });

      it('defers unrelated notification text until the per_task result settles', async () => {
        const task = {
          id: 'related-agent',
          status: 'running',
          isBackgrounded: true,
          notified: false,
          todoWorkChainId: workChainId,
        };
        mockBackgroundTaskRegistry.getAll.mockReturnValue([task]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(textStream('Main result'))
          .mockResolvedValueOnce(textStream('Unrelated background result'));
        const resultPromise = session.prompt(taskPrompt);
        try {
          await expectMainReleased();
          emitNotification('agent', 'unrelated-agent', 'another-chain');
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          task.status = 'completed';
          task.notified = true;
          const result = await resultPromise;
          await vi.waitFor(() => {
            const response = vi
              .mocked(mockClient.sessionUpdate)
              .mock.calls.map(([params]) => params.update)
              .find(
                (update) =>
                  update.sessionUpdate === 'agent_message_chunk' &&
                  update.content.type === 'text' &&
                  update.content.text === 'Unrelated background result',
              );
            expect(response).toBeDefined();
            expect(
              response?._meta?.[CHANNEL_TASK_OUTPUT_META_KEY],
            ).toBeUndefined();
          });
          expect(result.stopReason).toBe('end_turn');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
        } finally {
          session.dispose();
          await resultPromise;
        }
      });

      it('does not wait for unrelated or unowned work and keeps the main result fallback', async () => {
        mockBackgroundTaskRegistry.getAll.mockReturnValue([
          {
            id: 'old-agent',
            status: 'running',
            isBackgrounded: true,
            todoWorkChainId: 'previous-user-task',
          },
          { id: 'unowned-agent', status: 'running', isBackgrounded: true },
        ]);
        mockMonitorRegistry.getAll.mockReturnValue([
          { id: 'unowned-monitor', status: 'running' },
        ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(textStream('Main final'));
        const result = await session.prompt(taskPrompt);
        expect(result.stopReason).toBe('end_turn');
        expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
      });

      it.each(['none', 'complete', 'empty'] as const)(
        'preserves partial task output with a %s successor response',
        async (successor) => {
          const first = {
            id: 'agent-1',
            description: 'Related background task',
            status: 'running',
            isBackgrounded: true,
            notified: false,
            todoWorkChainId: workChainId,
          };
          const second = { ...first, id: 'agent-2' };
          mockBackgroundTaskRegistry.getAll.mockReturnValue([first, second]);
          mockToolRegistry.getTool.mockReturnValue({
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: {},
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Read file'),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: vi.fn().mockResolvedValue({
                llmContent: 'file contents',
                returnDisplay: 'file contents',
              }),
            }),
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(textStream('Main result'))
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    candidates: [
                      { content: { parts: [{ text: 'Partial result' }] } },
                    ],
                    functionCalls: [
                      { id: 'read-1', name: 'read_file', args: {} },
                    ],
                  },
                },
              ]),
            )
            .mockRejectedValueOnce(
              new Error('Background follow-up unavailable'),
            )
            .mockResolvedValueOnce(
              textStream(successor === 'complete' ? 'Complete result' : '  '),
            );
          const resultPromise = session.prompt(taskPrompt);
          const backgroundResponses = () =>
            vi
              .mocked(mockClient.sessionUpdate)
              .mock.calls.map(([params]) => params.update)
              .filter(
                (update) =>
                  update._meta?.['source'] ===
                  'background_notification_response',
              );
          try {
            await expectMainReleased();
            first.status = 'completed';
            first.notified = true;
            emitNotification('agent', first.id);
            await vi.waitFor(() =>
              expect(backgroundResponses()).toContainEqual(
                expect.objectContaining({
                  _meta: expect.objectContaining({
                    backgroundTask: expect.objectContaining({
                      taskId: first.id,
                      turnComplete: true,
                      partial: true,
                    }),
                  }),
                }),
              ),
            );
            second.status = 'completed';
            second.notified = true;
            if (successor !== 'none') emitNotification('agent', second.id);
            const result = await resultPromise;
            expect(result.stopReason).toBe('end_turn');
            expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBe(
              successor === 'complete' ? 'Complete result' : 'Partial result',
            );
            expect(result._meta?.['qwen.channel.taskResultPartial']).toBe(
              successor !== 'complete',
            );
            if (successor !== 'none') {
              const terminalTurns = backgroundResponses().flatMap((update) => {
                const context = update._meta?.['backgroundTask'] as {
                  turnId: string;
                  turnComplete: boolean;
                };
                return context.turnComplete ? [context.turnId] : [];
              });
              expect(new Set(terminalTurns).size).toBe(2);
            }
          } finally {
            session.dispose();
            await resultPromise;
          }
        },
      );

      it.each(['per_turn', 'per_response'])(
        'does not wait in %s mode',
        async (outputMode) => {
          mockBackgroundTaskRegistry.getAll.mockReturnValue([
            {
              id: 'agent-1',
              status: 'running',
              isBackgrounded: true,
              todoWorkChainId: workChainId,
            },
          ]);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(textStream('Main final'));
          const result = await session.prompt({
            ...taskPrompt,
            _meta: {
              ...taskPrompt._meta,
              [CHANNEL_OUTPUT_MODE_META_KEY]: outputMode,
            },
          });
          expect(result.stopReason).toBe('end_turn');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
        },
      );

      it.each(['admission', 'session-cancel', 'dispose'])(
        'releases a per_task wait on %s without returning a stale success result',
        async (cancelMode) => {
          mockBackgroundTaskRegistry.getAll.mockReturnValue([
            {
              id: 'agent-1',
              status: 'running',
              isBackgrounded: true,
              todoWorkChainId: workChainId,
            },
          ]);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(textStream('Main final'));
          const cancellation = new AbortController();
          const resultPromise = session.prompt(
            taskPrompt,
            undefined,
            cancellation.signal,
          );
          await expectMainReleased();
          if (cancelMode === 'admission') cancellation.abort();
          else if (cancelMode === 'dispose') session.dispose();
          else await session.cancelPendingPrompt();
          const result = await resultPromise;
          expect(result.stopReason).toBe('cancelled');
          expect(result._meta?.[CHANNEL_TASK_RESULT_META_KEY]).toBeUndefined();
          expect(
            (
              session as unknown as {
                channelTaskCaptures: Set<unknown>;
              }
            ).channelTaskCaptures.size,
          ).toBe(0);
        },
      );
    });

    describe('background execution lifecycle', () => {
      const completedText = (text: string) =>
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text }] } }],
            },
          },
        ]);
      const notification = () =>
        mockBackgroundTaskRegistry.setNotificationCallback.mock.calls[0][0] as (
          display: string,
          model: string,
          meta: { agentId: string; status: string; sourceTurnId?: string },
        ) => void;
      const monitorNotification = () =>
        mockMonitorRegistry.setNotificationCallback.mock
          .calls[0][0] as core.MonitorNotificationCallback;
      const workflowNotification = () =>
        mockWorkflowRunRegistry.setCompletionCallback.mock.calls[0][0] as (
          display: string,
          model: string,
          meta: {
            runId: string;
            status: string;
            sourceTurnId?: string;
          },
        ) => void;

      it.each(['session cancel', 'admission cancel'])(
        'keeps notifications paused when a waiting successor ends via %s',
        async (mode) => {
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              (async function* () {
                yield {
                  type: core.StreamEventType.CHUNK,
                  value: { candidates: [{ content: { parts: [] } }] },
                };
                await gate;
              })(),
            )
            .mockImplementation(async () => createEmptyStream());
          const first = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first' }],
          });
          let successor: Promise<unknown> | undefined;
          const cancel = new AbortController();
          try {
            await vi.waitFor(() =>
              expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1),
            );
            await session.cancelPendingPrompt();
            successor = session.prompt(
              {
                sessionId: 'test-session-id',
                prompt: [{ type: 'text', text: 'cancelled successor' }],
              },
              undefined,
              cancel.signal,
            );
            await vi.waitFor(() =>
              expect(
                (
                  session as unknown as {
                    pendingPrompt: AbortController | null;
                  }
                ).pendingPrompt?.signal.aborted,
              ).toBe(false),
            );
            if (mode === 'session cancel') await session.cancelPendingPrompt();
            else cancel.abort();
            release();
            await first;
            await successor;
            notification()('worker complete', 'RETAINED_RESULT', {
              agentId: 'paused-worker',
              status: 'completed',
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            expect(session.collectActiveWorkHolds()).toContainEqual({
              category: 'notification',
              id: 'paused-worker',
            });
            expect(mockClient.extMethod).not.toHaveBeenCalledWith(
              '_qwencode/start_turn',
              expect.anything(),
            );
            await session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'resume' }],
            });
            await vi.waitFor(() =>
              expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3),
            );
            expect(
              vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
            ).toContainEqual({ text: 'RETAINED_RESULT' });
            await vi.waitFor(() =>
              expect(session.getBackgroundTurn()).toBeUndefined(),
            );
          } finally {
            release();
            await Promise.allSettled([first, successor]);
          }
        },
      );

      it.each(['inner check', 'bridge request'] as const)(
        'retries one transient %s failure without another user prompt',
        async (failureAt) => {
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(async () => createEmptyStream());
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          });
          vi.useFakeTimers();
          try {
            if (failureAt === 'inner check')
              mockConfig.assertCanStartTurn = vi
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('temporary'))
                .mockResolvedValue(undefined);
            else
              vi.mocked(mockClient.extMethod).mockRejectedValueOnce(
                new Error('temporary'),
              );
            notification()('done', 'RESULT', {
              agentId: 'retry-worker',
              status: 'completed',
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1100);
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
            expect(session.getFinishedBackgroundTurnId()).toEqual(
              expect.any(String),
            );
            expect(
              session
                .collectActiveWorkHolds()
                .some((hold) => hold.id === 'retry-worker'),
            ).toBe(false);
          } finally {
            vi.useRealTimers();
          }
        },
      );

      it('defers admission when the host never answers the start_turn request', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(async () => createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
          if (method === '_qwencode/start_turn')
            return new Promise(() => undefined);
          return { messages: [], hasQueuedPrompt: false };
        });
        vi.useFakeTimers();
        try {
          notification()('done', 'RESULT', {
            agentId: 'silent-host-worker',
            status: 'completed',
          });
          await vi.advanceTimersByTimeAsync(0);
          const starts = () =>
            vi
              .mocked(mockClient.extMethod)
              .mock.calls.filter(
                ([method]) => method === '_qwencode/start_turn',
              );
          expect(starts()).toHaveLength(1);
          // The admission deadline releases the turn: the item is retained
          // via the defer path (same turnId on the retry) rather than lost,
          // and the notification pipeline is not wedged.
          await vi.advanceTimersByTimeAsync(2100);
          expect(
            (session as unknown as { notificationProcessing: boolean })
              .notificationProcessing,
          ).toBe(false);
          expect(
            session
              .collectActiveWorkHolds()
              .some((hold) => hold.id === 'silent-host-worker'),
          ).toBe(true);
          // The defer path retries with the SAME turnId after the backoff.
          await vi.advanceTimersByTimeAsync(1100);
          expect(starts().length).toBeGreaterThan(1);
          expect(
            new Set(starts().map(([, params]) => params['turnId'])).size,
          ).toBe(1);
          // Let the second silent attempt hit its own admission deadline so
          // no fake-timer race is left dangling across the switch below.
          await vi.advanceTimersByTimeAsync(2100);
          expect(
            (session as unknown as { notificationProcessing: boolean })
              .notificationProcessing,
          ).toBe(false);
        } finally {
          vi.useRealTimers();
        }
        const followUp = await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'next question' }],
        });
        expect(followUp.stopReason).toBe('end_turn');
      });

      it.each([false, true])(
        'bounds admission retries and honors explicit stop=%s',
        async (stop) => {
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(async () => createEmptyStream());
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          });
          vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
            if (method === '_qwencode/start_turn')
              throw new Error('unavailable');
            return { messages: [], hasQueuedPrompt: false };
          });
          vi.useFakeTimers();
          try {
            notification()('done', 'RESULT', {
              agentId: 'retry-worker',
              status: 'completed',
            });
            await vi.advanceTimersByTimeAsync(0);
            if (stop) {
              // A retrying result has no executing model; the cancellation path still needs to pause it.
              await session.cancelPendingPrompt();
            }
            await vi.advanceTimersByTimeAsync(60000);
            const starts = vi
              .mocked(mockClient.extMethod)
              .mock.calls.filter(
                ([method]) => method === '_qwencode/start_turn',
              );
            expect(starts).toHaveLength(stop ? 1 : 4);
            expect(
              new Set(starts.map(([, params]) => params['turnId'])).size,
            ).toBe(1);
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            expect(
              session
                .collectActiveWorkHolds()
                .some((hold) => hold.id === 'retry-worker'),
            ).toBe(true);
          } finally {
            vi.useRealTimers();
          }
        },
      );

      it('retains a result cancelled during the inner automatic admission check', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(async () => createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        let releaseAdmission!: () => void;
        const admission = new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        });
        mockConfig.assertCanStartTurn = vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockReturnValueOnce(admission)
          .mockResolvedValue(undefined);
        notification()('worker complete', 'RETAIN_AFTER_CANCEL', {
          agentId: 'cancelled-admission-worker',
          status: 'completed',
        });
        await vi.waitFor(() =>
          expect(mockConfig.assertCanStartTurn).toHaveBeenCalledTimes(2),
        );
        await session.cancelPendingPrompt();
        releaseAdmission();
        await vi.waitFor(() =>
          expect(session.collectActiveWorkHolds()).toEqual(
            expect.arrayContaining([
              { category: 'notification', id: 'cancelled-admission-worker' },
            ]),
          ),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'resume' }],
        });
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3),
        );
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'RETAIN_AFTER_CANCEL' }]));
      });

      it.each(['inner check', 'bridge request'])(
        'retains a result when the automatic admission %s rejects',
        async (failureAt) => {
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(async () => createEmptyStream());
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          });
          const failure = new Error('admission unavailable');
          if (failureAt === 'inner check') {
            mockConfig.assertCanStartTurn = vi
              .fn()
              .mockResolvedValueOnce(undefined)
              .mockRejectedValueOnce(failure)
              .mockResolvedValue(undefined);
          } else {
            vi.mocked(mockClient.extMethod).mockRejectedValueOnce(failure);
          }
          notification()('worker complete', 'RETAIN_AFTER_ERROR', {
            agentId: 'rejected-admission-worker',
            status: 'completed',
          });
          await vi.waitFor(() =>
            expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
              'Background turn could not start; retaining result:',
              expect.any(Error),
            ),
          );
          await vi.waitFor(() =>
            expect(session.collectActiveWorkHolds()).toEqual(
              expect.arrayContaining([
                { category: 'notification', id: 'rejected-admission-worker' },
              ]),
            ),
          );
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'retry' }],
          });
          await vi.waitFor(() =>
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3),
          );
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
          ).toEqual(expect.arrayContaining([{ text: 'RETAIN_AFTER_ERROR' }]));
        },
      );

      it('preserves a same-turn result when cancelled while displaying its consumption', async () => {
        mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
          notification()('worker complete', 'RESULT_DURING_CANCEL', {
            agentId: 'same-worker',
            status: 'completed',
            sourceTurnId: core.promptIdContext.getStore(),
          });
          return completedText('Initial answer');
        });
        vi.mocked(mockClient.sessionUpdate).mockImplementation(
          async ({ update }) => {
            if (update._meta?.['source'] === 'background_notification')
              await session.cancelPendingPrompt();
          },
        );
        const result = await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        expect(result.stopReason).toBe('cancelled');
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [{ text: 'RESULT_DURING_CANCEL' }],
        });
      });

      it('preserves steering cancelled after the automatic final-boundary drain', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(async () => completedText('answer'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
          if (method === '_qwencode/start_turn') return { accepted: true };
          if (method === 'craft/drainMidTurnQueue') {
            await session.cancelPendingPrompt();
            return {
              messages: ['STEERING_DURING_CANCEL'],
              hasQueuedPrompt: false,
            };
          }
          return {};
        });
        notification()('worker complete', 'RESULT', {
          agentId: 'worker',
          status: 'completed',
        });
        await vi.waitFor(() =>
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            expect.objectContaining({
              source: 'background_notification',
              reason: 'cancelled',
            }),
          ),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          JSON.stringify(vi.mocked(mockChat.addHistory).mock.calls),
        ).toContain('STEERING_DURING_CANCEL');
      });

      it('falls back for legacy hosts returning a raw ACP method-not-found error', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(async () => completedText('done'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
          if (method === '_qwencode/start_turn')
            throw { code: -32601, message: 'Method not found' };
          return { messages: [], hasQueuedPrompt: false };
        });
        notification()('worker complete', 'LEGACY_RESULT', {
          agentId: 'legacy-worker',
          status: 'completed',
        });
        await vi.waitFor(() =>
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            expect.objectContaining({ source: 'background_notification' }),
          ),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'LEGACY_RESULT' }]));
      });

      it.each(['delivered', 'cancelled', 'display failed'])(
        'preserves the same-turn overflow summary when %s',
        async (mode) => {
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () => {
              for (let index = 0; index < 21; index++) {
                notification()('worker complete', `<result-${index} />`, {
                  agentId: `worker-${index}`,
                  status: 'completed',
                  sourceTurnId: core.promptIdContext.getStore(),
                });
              }
              return completedText('Initial response');
            })
            .mockResolvedValue(completedText('Results incorporated'));
          vi.mocked(mockClient.sessionUpdate).mockImplementation(
            async ({ update }) => {
              if (update._meta?.backgroundTask?.kind !== 'queue') return;
              if (mode === 'cancelled') await session.cancelPendingPrompt();
              if (mode === 'display failed') throw new Error('display failed');
            },
          );

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          });
          const calls = vi.mocked(mockChat.sendMessageStream).mock.calls;
          expect(calls).toHaveLength(mode === 'cancelled' ? 1 : 2);
          expect(result.stopReason).toBe(
            mode === 'cancelled' ? 'cancelled' : 'end_turn',
          );
          const parts = (
            mode === 'cancelled'
              ? vi.mocked(mockChat.addHistory).mock.calls.at(-1)?.[0].parts
              : calls[1][1].message
          ) as Array<{ text: string }>;
          expect(parts).toHaveLength(21);
          expect(parts[0].text).toContain('<kind>queue</kind>');
          expect(parts[0].text).toContain('worker-0');
          expect(parts.slice(1)).toEqual(
            Array.from({ length: 20 }, (_, index) => ({
              text: `<result-${index + 1} />`,
            })),
          );
          expect(
            mockChatRecordingService.recordNotification.mock.calls[0][0],
          ).toEqual([parts[0]]);
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({
                _meta: expect.objectContaining({
                  source: 'background_notification',
                  backgroundTask: expect.objectContaining({
                    taskId: 'worker-1',
                  }),
                }),
              }),
            }),
          );
          const internals = session as unknown as {
            notificationQueue: unknown[];
            droppedNotifications: { count: number };
          };
          expect(internals.notificationQueue).toHaveLength(0);
          expect(internals.droppedNotifications.count).toBe(0);
          expect(mockClient.extMethod).not.toHaveBeenCalledWith(
            '_qwencode/start_turn',
            expect.anything(),
          );
        },
      );

      it('consumes a same-turn result before final completion without automatic rerun', async () => {
        const notify = notification();
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(async () => {
            notify('worker complete', 'SAME_TURN_RESULT', {
              agentId: 'same-worker',
              status: 'completed',
              sourceTurnId: core.promptIdContext.getStore(),
            });
            return completedText('Initial response');
          })
          .mockResolvedValue(completedText('Result incorporated'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'SAME_TURN_RESULT' }]));
        expect(
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.some(([method]) => method === '_qwencode/start_turn'),
        ).toBe(false);
        expect(
          session
            .collectActiveWorkHolds()
            .some((hold) => hold.id === 'same-worker'),
        ).toBe(false);
      });

      it('consumes same-turn monitor and workflow results before final completion', async () => {
        const notifyMonitor = monitorNotification();
        const notifyWorkflow = workflowNotification();
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(async () => {
            const sourceTurnId = core.promptIdContext.getStore();
            notifyMonitor('monitor complete', 'SAME_TURN_MONITOR', {
              monitorId: 'same-monitor',
              status: 'completed',
              eventCount: 1,
              sourceTurnId,
            });
            notifyWorkflow('workflow complete', 'SAME_TURN_WORKFLOW', {
              runId: 'same-workflow',
              status: 'completed',
              sourceTurnId,
            });
            return completedText('Initial response');
          })
          .mockResolvedValue(completedText('Results incorporated'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(
          expect.arrayContaining([
            { text: 'SAME_TURN_MONITOR' },
            { text: 'SAME_TURN_WORKFLOW' },
          ]),
        );
        expect(
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.some(([method]) => method === '_qwencode/start_turn'),
        ).toBe(false);
      });

      it('consumes same-turn monitor and workflow results under a bridge invocation context', async () => {
        const notifyMonitor = monitorNotification();
        const notifyWorkflow = workflowNotification();
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(async () => {
            const sourceTurnId = 'bridge-turn';
            notifyMonitor('monitor complete', 'BRIDGE_TURN_MONITOR', {
              monitorId: 'bridge-monitor',
              status: 'completed',
              eventCount: 1,
              sourceTurnId,
            });
            notifyWorkflow('workflow complete', 'BRIDGE_TURN_WORKFLOW', {
              runId: 'bridge-workflow',
              status: 'completed',
              sourceTurnId,
            });
            return completedText('Initial response');
          })
          .mockResolvedValue(completedText('Results incorporated'));
        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'bridge-turn',
          },
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(
          expect.arrayContaining([
            { text: 'BRIDGE_TURN_MONITOR' },
            { text: 'BRIDGE_TURN_WORKFLOW' },
          ]),
        );
        expect(
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.some(([method]) => method === '_qwencode/start_turn'),
        ).toBe(false);
      });

      it.each([
        {
          kind: 'monitor',
          notify: (sourceTurnId: string) =>
            monitorNotification()('monitor complete', 'TOOL_MONITOR', {
              monitorId: 'tool-monitor',
              status: 'completed',
              eventCount: 1,
              sourceTurnId,
            }),
          result: 'TOOL_MONITOR',
        },
        {
          kind: 'workflow',
          notify: (sourceTurnId: string) =>
            workflowNotification()('workflow complete', 'TOOL_WORKFLOW', {
              runId: 'tool-workflow',
              status: 'completed',
              sourceTurnId,
            }),
          result: 'TOOL_WORKFLOW',
        },
      ])(
        'consumes a same-turn $kind result in the next tool continuation',
        async ({ notify, result }) => {
          const execute = vi.fn(async (_signal?: AbortSignal) => {
            const sourceTurnId = core.promptIdContext.getStore();
            if (!sourceTurnId) throw new Error('missing prompt context');
            notify(sourceTurnId);
            return {
              llmContent: 'TOOL_RESULT',
              returnDisplay: 'TOOL_RESULT',
            };
          });
          mockToolRegistry.getTool.mockReturnValue({
            name: 'run_shell_command',
            kind: core.Kind.Execute,
            displayName: 'Run shell command',
            description: 'Run a shell command',
            build: vi.fn().mockReturnValue({
              params: { command: 'echo hi' },
              execute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('echo hi'),
              toolLocations: vi.fn().mockReturnValue([]),
            }),
            canUpdateOutput: false,
            isOutputMarkdown: false,
          });
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          runAcpToolBatchSpy
            .mockReset()
            .mockImplementation(
              async (
                _host: unknown,
                { requests }: { requests: core.ToolCallRequestInfo[] },
              ) => {
                const [request] = requests;
                if (!request) throw new Error('missing tool request');
                const output = await execute(new AbortController().signal);
                const part = {
                  functionResponse: {
                    id: request.callId,
                    name: request.name,
                    response: { output: output.llmContent },
                  },
                };
                return {
                  parts: [part],
                  results: [
                    {
                      request,
                      executionRequest: request,
                      response: {
                        callId: request.callId,
                        responseParts: [part],
                        resultDisplay: output.returnDisplay,
                        executionStatus: 'success',
                      },
                      status: 'success',
                      origin: 'executed',
                    },
                  ],
                  stopAfterPermissionCancel: false,
                };
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
                        id: 'tool-call',
                        name: 'run_shell_command',
                        args: { command: 'echo hi' },
                      },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValue(completedText('Tool result incorporated'));

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'start' }],
          });

          expect(execute).toHaveBeenCalledOnce();
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          const [firstRequest, secondRequest] = vi.mocked(
            mockChat.sendMessageStream,
          ).mock.calls;
          expect(
            (firstRequest[1].message as Part[]).some(
              (part) => part.text === result,
            ),
          ).toBe(false);
          expect(secondRequest[1].message).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                functionResponse: expect.objectContaining({
                  response: expect.objectContaining({ output: 'TOOL_RESULT' }),
                }),
              }),
              expect.objectContaining({ text: result }),
            ]),
          );
          expect(
            (secondRequest[1].message as Part[]).filter(
              (part) => part.text === result,
            ),
          ).toHaveLength(1);
        },
      );

      it('consumes a same-turn shell result without an automatic rerun', async () => {
        const notifyShell = mockBackgroundShellRegistry.setNotificationCallback
          .mock.calls[0][0] as (
          display: string,
          model: string,
          meta: {
            shellId: string;
            status: string;
            sourceTurnId?: string;
          },
        ) => void;
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(async () => {
            notifyShell('shell complete', 'SAME_TURN_SHELL_RESULT', {
              shellId: 'same-shell',
              status: 'completed',
              sourceTurnId: core.promptIdContext.getStore(),
            });
            return completedText('Initial response');
          })
          .mockResolvedValue(completedText('Shell result incorporated'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        expect(
          session
            .collectActiveWorkHolds()
            .some((hold) => hold.category === 'shell'),
        ).toBe(false);
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'SAME_TURN_SHELL_RESULT' }]));
        expect(
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.some(([method]) => method === '_qwencode/start_turn'),
        ).toBe(false);
      });

      it.each([
        {
          kind: 'monitor',
          notify: () =>
            monitorNotification()('monitor complete', 'OLDER_MONITOR', {
              monitorId: 'older-monitor',
              status: 'completed',
              eventCount: 1,
              sourceTurnId: 'older-turn',
            }),
          taskId: 'older-monitor',
          result: 'OLDER_MONITOR',
          sourceTurnId: 'older-turn',
        },
        {
          kind: 'workflow',
          notify: () =>
            workflowNotification()('workflow complete', 'OLDER_WORKFLOW', {
              runId: 'older-workflow',
              status: 'completed',
              sourceTurnId: 'older-turn',
            }),
          taskId: 'older-workflow',
          result: 'OLDER_WORKFLOW',
          sourceTurnId: 'older-turn',
        },
        {
          kind: 'monitor',
          notify: () =>
            monitorNotification()('monitor complete', 'UNATTRIBUTED_MONITOR', {
              monitorId: 'unattributed-monitor',
              status: 'completed',
              eventCount: 1,
            }),
          taskId: 'unattributed-monitor',
          result: 'UNATTRIBUTED_MONITOR',
          sourceTurnId: undefined,
        },
        {
          kind: 'workflow',
          notify: () =>
            workflowNotification()(
              'workflow complete',
              'UNATTRIBUTED_WORKFLOW',
              {
                runId: 'unattributed-workflow',
                status: 'completed',
              },
            ),
          taskId: 'unattributed-workflow',
          result: 'UNATTRIBUTED_WORKFLOW',
          sourceTurnId: undefined,
        },
      ])(
        'leaves an earlier-turn or unattributed $kind result for automatic admission',
        async ({ notify, taskId, result, sourceTurnId }) => {
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () => {
              notify();
              return completedText('New user answer');
            })
            .mockResolvedValue(completedText('Earlier result handled'));
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'new question' }],
          });
          await vi.waitFor(() =>
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
          );
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            '_qwencode/start_turn',
            expect.objectContaining({
              source: 'background_notification',
              taskId,
            }),
          );
          const startTurn = vi
            .mocked(mockClient.extMethod)
            .mock.calls.find(([method]) => method === '_qwencode/start_turn');
          if (sourceTurnId) {
            expect(startTurn?.[1]).toEqual(
              expect.objectContaining({ sourceTurnId }),
            );
          } else {
            expect(startTurn?.[1]).not.toHaveProperty('sourceTurnId');
          }
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
          ).toEqual(expect.arrayContaining([{ text: result }]));
          await vi.waitFor(() =>
            expect(session.getBackgroundTurn()).toBeUndefined(),
          );
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          const startTurnIndex = vi
            .mocked(mockClient.extMethod)
            .mock.calls.findIndex(
              ([method]) => method === '_qwencode/start_turn',
            );
          expect(
            vi.mocked(mockClient.extMethod).mock.invocationCallOrder[
              startTurnIndex
            ],
          ).toBeLessThan(
            vi.mocked(mockChat.sendMessageStream).mock.invocationCallOrder[1],
          );
        },
      );

      it('leaves an earlier-turn result for a separately admitted automatic execution', async () => {
        const notify = notification();
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(async () => {
            notify('older worker complete', 'OLDER_RESULT', {
              agentId: 'old-worker',
              status: 'completed',
              sourceTurnId: 'older-turn',
            });
            return completedText('New user answer');
          })
          .mockResolvedValue(completedText('Older result handled'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'new question' }],
        });
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
        );
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          '_qwencode/start_turn',
          expect.objectContaining({
            source: 'background_notification',
            taskId: 'old-worker',
            sourceTurnId: 'older-turn',
          }),
        );
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[1][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'OLDER_RESULT' }]));
        await vi.waitFor(() =>
          expect(session.getBackgroundTurn()).toBeUndefined(),
        );
      });

      it('consumes steering at a tool-free final boundary before emitting the terminal', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(completedText('First automatic answer'))
          .mockResolvedValue(completedText('Steering incorporated'));
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        let steered = false;
        vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
          if (method === '_qwencode/start_turn') return { accepted: true };
          if (method === 'craft/drainMidTurnQueue' && !steered) {
            steered = true;
            return { messages: ['USER_STEERING'], hasQueuedPrompt: false };
          }
          return { messages: [], hasQueuedPrompt: false };
        });
        notification()('worker complete', 'RESULT', {
          agentId: 'worker',
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
          .mock.calls.find(([method]) => method === '_qwencode/start_turn')!;
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          'craft/drainMidTurnQueue',
          expect.objectContaining({ promptId: start[1]['turnId'] }),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        expect(
          JSON.stringify(
            vi.mocked(mockChat.sendMessageStream).mock.calls[2][1].message,
          ),
        ).toContain('USER_STEERING');
        const responses = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([call]) => call.update)
          .filter(
            (update) =>
              update._meta?.['source'] === 'background_notification_response',
          );
        expect(
          responses.map(
            (update) =>
              (update._meta?.['backgroundTask'] as { turnComplete: boolean })
                .turnComplete,
          ),
        ).toEqual([false, false, true]);
      });

      it('retains waiting results on explicit stop and resumes only after user input', async () => {
        let automaticSignal: AbortSignal | undefined;
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockImplementationOnce(async (_model, request) => {
            automaticSignal = request.config.abortSignal;
            await new Promise<void>((resolve) =>
              automaticSignal!.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            return createEmptyStream();
          })
          .mockImplementation(async () => createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start' }],
        });
        const notify = notification();
        notify('one', 'ONE', { agentId: 'one', status: 'completed' });
        await vi.waitFor(() => expect(automaticSignal).toBeDefined());
        notify('two', 'TWO', { agentId: 'two', status: 'completed' });
        await session.cancelPendingPrompt();
        await vi.waitFor(() =>
          expect(session.getBackgroundTurn()).toBeUndefined(),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(session.collectActiveWorkHolds()).toEqual(
          expect.arrayContaining([{ category: 'notification', id: 'two' }]),
        );
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'resume' }],
        });
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(4),
        );
        expect(
          vi.mocked(mockChat.sendMessageStream).mock.calls[3][1].message,
        ).toEqual(expect.arrayContaining([{ text: 'TWO' }]));
      });
    });

    it('drains background task notifications through ACP after the prompt is idle', async () => {
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
                      parts: [{ text: 'I saw the background result.' }],
                    },
                  },
                ],
              },
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
        meta: {
          agentId: string;
          status: string;
          toolUseId?: string;
          todoWorkChainId?: string;
          label?: string;
        },
      ) => void;

      callback(
        'Background agent "worker" completed.',
        '<task-notification><status>completed</status></task-notification>',
        {
          agentId: 'agent-1',
          status: 'completed',
          toolUseId: 'tool-1',
          todoWorkChainId: 'work-chain-1',
          label: 'worker',
        },
      );

      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });

      expect(mockChat.sendMessageStream).toHaveBeenNthCalledWith(
        2,
        'qwen3-code-plus',
        {
          message: [
            {
              text: '<task-notification><status>completed</status></task-notification>',
            },
          ],
          config: { abortSignal: expect.any(AbortSignal) },
        },
        expect.stringMatching(/^test-session-id########notification[\w-]+$/),
        undefined,
        undefined,
      );
      expect(mockChatRecordingService.recordNotification).toHaveBeenCalledWith(
        [
          {
            text: '<task-notification><status>completed</status></task-notification>',
          },
        ],
        'Background agent "worker" completed.',
        {
          taskId: 'agent-1',
          status: 'completed',
          kind: 'agent',
          toolUseId: 'tool-1',
        },
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Background agent "worker" completed.',
          },
          _meta: {
            backgroundTurn: expect.objectContaining({
              taskId: 'agent-1',
              kind: 'agent',
              turnId: expect.any(String),
            }),
            source: 'background_notification',
            qwenDiscreteMessage: true,
            backgroundTask: {
              taskId: 'agent-1',
              status: 'completed',
              kind: 'agent',
              toolUseId: 'tool-1',
            },
          },
        },
      });
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'I saw the background result.' },
          _meta: {
            backgroundTurn: expect.objectContaining({
              taskId: 'agent-1',
              kind: 'agent',
              turnId: expect.any(String),
            }),
            source: 'background_notification_response',
            qwenDiscreteMessage: true,
            backgroundTask: {
              taskId: 'agent-1',
              status: 'completed',
              kind: 'agent',
              toolUseId: 'tool-1',
              label: 'worker',
              turnId: expect.stringMatching(
                /^test-session-id########notification[\w-]+$/,
              ),
              turnComplete: false,
            },
          },
        },
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
    });

    it('emits one terminal marker after all background notification response segments', async () => {
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          }),
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'I will inspect first.' }] } },
                ],
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
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'The final finding.' }] } },
                ],
              },
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
        meta: { agentId: string; status: string; label?: string },
      ) => void;
      callback('done', '<task-notification />', {
        agentId: 'agent-1',
        status: 'completed',
        label: 'worker',
      });

      await vi.waitFor(() => {
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            _meta: expect.objectContaining({
              source: 'background_notification_response',
              backgroundTask: expect.objectContaining({ turnComplete: true }),
            }),
          }),
        });
      });
      const responses = (
        mockClient.sessionUpdate as ReturnType<typeof vi.fn>
      ).mock.calls
        .map(([params]) => params as SessionNotification)
        .filter(
          (params) =>
            params.update._meta?.['source'] ===
            'background_notification_response',
        );
      const responseTurnIds = responses.map(
        (params) =>
          (
            params.update._meta?.['backgroundTask'] as
              | { turnId?: string }
              | undefined
          )?.turnId,
      );
      expect(responseTurnIds[0]).toMatch(
        /^test-session-id########notification[\w-]+$/,
      );
      expect(responseTurnIds[1]).toBe(responseTurnIds[0]);
      expect(responseTurnIds[2]).toBe(responseTurnIds[0]);
      expect(responses).toEqual([
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: 'text', text: 'I will inspect first.' },
            _meta: expect.objectContaining({
              backgroundTask: expect.objectContaining({
                taskId: 'agent-1',
                turnComplete: false,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: 'text', text: 'The final finding.' },
            _meta: expect.objectContaining({
              backgroundTask: expect.objectContaining({
                taskId: 'agent-1',
                turnComplete: false,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: 'text', text: '' },
            _meta: expect.objectContaining({
              backgroundTask: expect.objectContaining({
                taskId: 'agent-1',
                turnComplete: true,
              }),
            }),
          }),
        }),
      ]);
    });

    it('marks a buffered background response partial when a later model iteration fails', async () => {
      const flushTurn = vi.fn().mockResolvedValue(undefined);
      const interceptUpdate = vi.fn(async (update: SessionUpdate) => {
        await session.sendUpdate(update);
      });
      session.messageRewriter = {
        interceptUpdate,
        flushTurn,
        waitForPendingRewrites: vi.fn().mockResolvedValue(undefined),
      } as unknown as Session['messageRewriter'];
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          }),
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'Partial finding.' }] } },
                ],
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
        .mockRejectedValueOnce(new Error('model failed'));

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start background work' }],
      });

      const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
        .calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { agentId: string; status: string; label?: string },
      ) => void;
      callback('done', '<task-notification />', {
        agentId: 'agent-1',
        status: 'completed',
        label: 'worker',
      });

      const sessionUpdate = mockClient.sessionUpdate as ReturnType<
        typeof vi.fn
      >;
      await vi.waitFor(() => {
        expect(
          sessionUpdate.mock.calls.filter(
            ([params]) =>
              (params as SessionNotification).update._meta?.['source'] ===
              'background_notification_response',
          ),
        ).toHaveLength(2);
      });
      const responseCallIndexes = sessionUpdate.mock.calls
        .map(([params], index) => ({
          index,
          params: params as SessionNotification,
        }))
        .filter(
          ({ params }) =>
            params.update._meta?.['source'] ===
            'background_notification_response',
        );
      const responses = responseCallIndexes.map(({ params }) => params);
      expect(responses).toEqual([
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: 'text', text: 'Partial finding.' },
            _meta: expect.objectContaining({
              backgroundTask: expect.objectContaining({
                taskId: 'agent-1',
                turnComplete: false,
              }),
            }),
          }),
        }),
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: 'text', text: '' },
            _meta: expect.objectContaining({
              backgroundTask: expect.objectContaining({
                taskId: 'agent-1',
                turnComplete: true,
                partial: true,
              }),
            }),
          }),
        }),
      ]);
      const endTurnCallIndex = (
        mockClient.extNotification as ReturnType<typeof vi.fn>
      ).mock.calls.findIndex(
        ([method, params]) =>
          method === '_qwencode/end_turn' &&
          (params as { source?: string }).source === 'background_notification',
      );
      expect(endTurnCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        sessionUpdate.mock.invocationCallOrder[
          responseCallIndexes.at(-1)!.index
        ],
      ).toBeLessThan(
        (mockClient.extNotification as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[endTurnCallIndex]!,
      );
      const terminalUpdateIndex = interceptUpdate.mock.calls.findIndex(
        ([update]) => {
          const backgroundTask = update._meta?.['backgroundTask'] as
            | { turnComplete?: boolean }
            | undefined;
          return (
            update._meta?.['source'] === 'background_notification_response' &&
            backgroundTask?.turnComplete === true
          );
        },
      );
      expect(terminalUpdateIndex).toBeGreaterThanOrEqual(0);
      expect(
        interceptUpdate.mock.invocationCallOrder[terminalUpdateIndex],
      ).toBeLessThan(flushTurn.mock.invocationCallOrder.at(-1)!);
      expect(flushTurn.mock.invocationCallOrder.at(-1)).toBeLessThan(
        (mockClient.extNotification as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[endTurnCallIndex]!,
      );
    });

    it('completes a buffered response when the final model iteration is empty', async () => {
      const flushTurn = vi.fn().mockResolvedValue(undefined);
      const waitForPendingRewrites = vi.fn().mockResolvedValue(undefined);
      const interceptUpdate = vi.fn(async (update: SessionUpdate) => {
        await session.sendUpdate(update);
      });
      session.messageRewriter = {
        interceptUpdate,
        flushTurn,
        waitForPendingRewrites,
      } as unknown as Session['messageRewriter'];
      mockToolRegistry.getTool.mockReturnValue({
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/test.txt' },
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue('Read file'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          }),
        }),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'Buffered finding.' }] } },
                ],
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
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/end_turn',
          expect.objectContaining({ source: 'background_notification' }),
        );
      });
      const terminalUpdateIndex = interceptUpdate.mock.calls.findIndex(
        ([update]) => {
          const content = (
            update as { content?: { type?: string; text?: string } }
          ).content;
          const backgroundTask = update._meta?.['backgroundTask'] as
            | { turnComplete?: boolean }
            | undefined;
          return (
            content?.type === 'text' &&
            content.text === '' &&
            backgroundTask?.turnComplete === true
          );
        },
      );
      const endTurnCallIndex = (
        mockClient.extNotification as ReturnType<typeof vi.fn>
      ).mock.calls.findIndex(
        ([method, params]) =>
          method === '_qwencode/end_turn' &&
          (params as { source?: string }).source === 'background_notification',
      );
      expect(terminalUpdateIndex).toBeGreaterThanOrEqual(0);
      expect(
        interceptUpdate.mock.invocationCallOrder[terminalUpdateIndex],
      ).toBeLessThan(flushTurn.mock.invocationCallOrder.at(-1)!);
      // The terminal marker must be followed by a flush and pending-rewrite
      // drain before end_turn so its metadata cannot leak into the next turn.
      expect(
        interceptUpdate.mock.invocationCallOrder[terminalUpdateIndex],
      ).toBeLessThan(waitForPendingRewrites.mock.invocationCallOrder.at(-1)!);
      expect(flushTurn.mock.invocationCallOrder.at(-1)).toBeLessThan(
        (mockClient.extNotification as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[endTurnCallIndex]!,
      );
    });
  });
});

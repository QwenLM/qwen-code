/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeInitialTurnFromHistory,
  fireSessionPermissionDeniedForAutoMode,
  Session,
} from './Session.js';
import type { Content } from '@google/genai';
import type { ChatRecord, Config, GeminiChat } from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  AuthType,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import type {
  AgentSideConnection,
  PromptRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';
import { CommandKind } from '../../ui/commands/types.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: debugLoggerWarnSpy,
      error: vi.fn(),
    }),
    generatePromptSuggestion: vi.fn(),
    logPromptSuggestion: vi.fn(),
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

// Helper to create empty async generator (avoids memory leak from inline generators)
function createEmptyStream() {
  return (async function* () {})();
}

// Helper to create async generator with chunks (avoids memory leak)
function createStreamWithChunks(
  chunks: Array<{ type: unknown; value: unknown }>,
) {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
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
  let mockChat: GeminiChat;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let mockSettings: LoadedSettings;
  let session: Session;
  let currentModel: string;
  let currentAuthType: AuthType;
  let switchModelSpy: ReturnType<typeof vi.fn>;
  let getAvailableCommandsSpy: ReturnType<typeof vi.fn>;
  let mockChatRecordingService: {
    recordUserMessage: ReturnType<typeof vi.fn>;
    recordMidTurnUserMessage: ReturnType<typeof vi.fn>;
    recordUiTelemetryEvent: ReturnType<typeof vi.fn>;
    recordToolResult: ReturnType<typeof vi.fn>;
    recordSlashCommand: ReturnType<typeof vi.fn>;
    recordNotification: ReturnType<typeof vi.fn>;
    recordFileHistorySnapshot: ReturnType<typeof vi.fn>;
    rewindRecording: ReturnType<typeof vi.fn>;
    setTitleRecordedCallback: ReturnType<typeof vi.fn>;
  };
  let mockFileHistoryService: {
    makeSnapshot: ReturnType<typeof vi.fn>;
    getSnapshots: ReturnType<typeof vi.fn>;
    restoreFromSnapshots: ReturnType<typeof vi.fn>;
    rewind: ReturnType<typeof vi.fn>;
  };
  let mockGeminiClient: {
    getChat: ReturnType<typeof vi.fn>;
    tryCompressChat: ReturnType<typeof vi.fn>;
  };
  let mockBackgroundTaskRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    hasUnfinalizedTasks: ReturnType<typeof vi.fn>;
  };
  let mockMonitorRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
  };
  let mockBackgroundShellRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
  };
  let mockToolRegistry: {
    getTool: ReturnType<typeof vi.fn>;
    ensureTool: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    currentModel = 'qwen3-code-plus';
    currentAuthType = AuthType.USE_OPENAI;
    switchModelSpy = vi
      .fn()
      .mockImplementation(async (authType: AuthType, modelId: string) => {
        currentAuthType = authType;
        currentModel = modelId;
      });

    mockChat = {
      sendMessageStream: vi.fn(),
      addHistory: vi.fn(),
      getHistory: vi.fn().mockReturnValue([]),
      getHistoryShallow: vi.fn().mockReturnValue([]),
      getLastModelMessageText: vi.fn().mockReturnValue(''),
      setHistory: vi.fn(),
      truncateHistory: vi.fn(),
      stripThoughtsFromHistory: vi.fn(),
    } as unknown as GeminiChat;
    mockGeminiClient = {
      getChat: vi.fn().mockReturnValue(mockChat),
      tryCompressChat: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      }),
    };
    mockBackgroundTaskRegistry = {
      setNotificationCallback: vi.fn(),
      hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
    };
    mockMonitorRegistry = {
      setNotificationCallback: vi.fn(),
    };
    mockBackgroundShellRegistry = {
      setNotificationCallback: vi.fn(),
    };

    mockChatRecordingService = {
      recordUserMessage: vi.fn(),
      recordMidTurnUserMessage: vi.fn(),
      recordUiTelemetryEvent: vi.fn(),
      recordToolResult: vi.fn(),
      recordSlashCommand: vi.fn(),
      recordNotification: vi.fn(),
      recordFileHistorySnapshot: vi.fn(),
      rewindRecording: vi.fn(),
      setTitleRecordedCallback: vi.fn(),
    };
    mockFileHistoryService = {
      makeSnapshot: vi.fn().mockResolvedValue(undefined),
      getSnapshots: vi.fn().mockReturnValue([]),
      restoreFromSnapshots: vi.fn(),
      rewind: vi.fn(),
    };

    mockToolRegistry = {
      getTool: vi.fn(),
      ensureTool: vi.fn().mockResolvedValue(true),
    };
    const fileService = { shouldGitIgnoreFile: vi.fn().mockReturnValue(false) };

    mockConfig = {
      setApprovalMode: vi.fn(),
      // #buildInitialSystemReminders branches on ApprovalMode.PLAN on every
      // session.prompt(), so the default must be defined. Individual tests
      // that care override via `mockConfig.getApprovalMode = vi.fn()...`.
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      switchModel: switchModelSpy,
      getModel: vi.fn().mockImplementation(() => currentModel),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi
        .fn()
        .mockReturnValue(mockChatRecordingService),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getFileService: vi.fn().mockReturnValue(fileService),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(process.cwd()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockImplementation(() => currentAuthType),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getSessionTokenLimit: vi.fn().mockReturnValue(0),
      getStopHookBlockingCap: vi.fn().mockReturnValue(8),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getBackgroundTaskRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundTaskRegistry),
      getBackgroundShellRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundShellRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(mockMonitorRegistry),
      getFileHistoryService: vi.fn().mockReturnValue(mockFileHistoryService),
    } as unknown as Config;

    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
      extNotification: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSideConnection;

    mockSettings = {
      merged: {},
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
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
    // Reset global runtime base dir state to prevent state leakage between tests
    core.Storage.setRuntimeBaseDir(null);
    // Clear session reference to allow garbage collection
    session = undefined as unknown as Session;
    mockChat = undefined as unknown as GeminiChat;
    mockConfig = undefined as unknown as Config;
    mockClient = undefined as unknown as AgentSideConnection;
    mockSettings = undefined as unknown as LoadedSettings;
    mockGeminiClient = undefined as unknown as typeof mockGeminiClient;
    mockToolRegistry = undefined as unknown as typeof mockToolRegistry;
    vi.restoreAllMocks();
    vi.clearAllTimers();
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
  });

  describe('sendCurrentModeUpdateNotification', () => {
    // The exit_plan_mode / edit-ProceedAlways path publishes the legacy
    // `session_update{current_mode_update}` frame itself (via sendUpdate),
    // so its extNotification must carry `legacyFrameSent: true` to stop the
    // bridge demux from emitting a second, duplicate legacy frame. Unlike
    // `setMode` (which omits the flag), a regression dropping it here would
    // double-publish to the IDE companion. (A2)
    it('marks the extNotification legacyFrameSent so the demux skips its dual-emit', async () => {
      await (
        session as unknown as {
          sendCurrentModeUpdateNotification: (
            outcome: core.ToolConfirmationOutcome,
          ) => Promise<void>;
        }
      ).sendCurrentModeUpdateNotification(
        core.ToolConfirmationOutcome.ProceedAlways,
      );

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
  });

  describe('rewindToTurn', () => {
    it('truncates model history before the requested user turn and records rewind', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
        { role: 'user', parts: [{ text: 'second' }] },
        { role: 'model', parts: [{ text: 'second reply' }] },
      ];
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(1);

      expect(result).toEqual({ targetTurnIndex: 1, apiTruncateIndex: 2 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(2);
      expect(mockChat.stripThoughtsFromHistory).toHaveBeenCalled();
      expect(mockChatRecordingService.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 2 },
        [],
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
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(0);

      expect(result).toEqual({ targetTurnIndex: 0, apiTruncateIndex: 1 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(1);
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
      vi.mocked(mockChat.getHistory).mockReturnValue(history);
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const result = session.rewindToTurn(1);

      // Keep startup + turn 1 + the MCP reminder (indices 0–3); truncate at
      // the second prompt (index 4). Counting the reminder would return 3.
      expect(result).toEqual({ targetTurnIndex: 1, apiTruncateIndex: 4 });
      expect(mockChat.truncateHistory).toHaveBeenCalledWith(4);
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

    it('restores a captured history snapshot', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'first reply' }] },
      ];
      vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);

      const snapshot = session.captureHistorySnapshot();
      session.restoreHistory(snapshot);

      expect(snapshot).toEqual(history);
      expect(mockChat.setHistory).toHaveBeenCalledWith(history);
      expect(mockChat.getHistory).not.toHaveBeenCalled();
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
    it('sets model via config and returns current model', async () => {
      const requested = `qwen3-coder-plus(${AuthType.USE_OPENAI})`;
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
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.USE_OPENAI,
      );
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
          currentModelId: 'qwen3-coder-plus',
        }),
      );
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
    });

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

    it('swallows errors and does not throw', async () => {
      getAvailableCommandsSpy.mockRejectedValueOnce(
        new Error('Command discovery failed'),
      );

      await expect(
        session.sendAvailableCommandsUpdate(),
      ).resolves.toBeUndefined();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
    });
  });

  describe('prompt', () => {
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
        meta: { agentId: string; status: string; toolUseId?: string },
      ) => void;

      callback(
        'Background agent "worker" completed.',
        '<task-notification><status>completed</status></task-notification>',
        {
          agentId: 'agent-1',
          status: 'completed',
          toolUseId: 'tool-1',
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
        expect.stringMatching(/^test-session-id########notification\d+$/),
      );
      expect(mockChatRecordingService.recordNotification).toHaveBeenCalledWith(
        [
          {
            text: '<task-notification><status>completed</status></task-notification>',
          },
        ],
        'Background agent "worker" completed.',
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
            source: 'background_notification_response',
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
      expect(mockClient.extNotification).toHaveBeenCalledWith(
        '_qwencode/end_turn',
        {
          sessionId: 'test-session-id',
          reason: 'end_turn',
          source: 'background_notification',
        },
      );
    });

    it('cancels an in-flight background notification prompt', async () => {
      const notificationCompression = {
        signal: undefined as AbortSignal | undefined,
      };
      mockGeminiClient.tryCompressChat = vi
        .fn()
        .mockResolvedValueOnce({
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: core.CompressionStatus.NOOP,
        })
        .mockImplementationOnce(
          async (_promptId: string, _force: boolean, signal: AbortSignal) => {
            notificationCompression.signal = signal;
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
            return {
              originalTokenCount: 0,
              newTokenCount: 0,
              compressionStatus: core.CompressionStatus.NOOP,
            };
          },
        );
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(createEmptyStream());

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
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
      });

      await session.cancelPendingPrompt();

      expect(notificationCompression.signal?.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/end_turn',
          {
            sessionId: 'test-session-id',
            reason: 'cancelled',
            source: 'background_notification',
          },
        );
      });
    });

    it('aborts an in-flight background notification before accepting a user prompt', async () => {
      const noopCompression = {
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      };
      let notificationSignal: AbortSignal | undefined;
      mockGeminiClient.tryCompressChat = vi
        .fn()
        .mockResolvedValueOnce(noopCompression)
        .mockImplementationOnce(
          async (_promptId: string, _force: boolean, signal: AbortSignal) => {
            notificationSignal = signal;
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
            return noopCompression;
          },
        )
        .mockResolvedValue(noopCompression);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

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
        expect(notificationSignal).toBeDefined();
      });

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'interrupt notification' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(notificationSignal?.aborted).toBe(true);
    });

    it('drops oldest background notifications when the queue reaches its cap', () => {
      (
        session as unknown as {
          pendingPrompt: AbortController | null;
        }
      ).pendingPrompt = new AbortController();

      const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
        .calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { agentId: string; status: string; toolUseId?: string },
      ) => void;

      for (let index = 0; index < 25; index++) {
        callback(
          `done ${index}`,
          `<task-notification>${index}</task-notification>`,
          {
            agentId: `agent-${index}`,
            status: 'completed',
          },
        );
      }

      const queued = (
        session as unknown as {
          notificationQueue: Array<{ taskId: string }>;
        }
      ).notificationQueue;
      expect(queued).toHaveLength(20);
      expect(queued[0]?.taskId).toBe('agent-5');
      expect(queued.at(-1)?.taskId).toBe('agent-24');
    });

    it('emits end_turn even when notification error display fails', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockRejectedValueOnce(new Error('notification blew up'));
      mockClient.sessionUpdate = vi.fn().mockImplementation(async (params) => {
        const text = (
          (params as SessionNotification).update as {
            content?: { text?: string };
          }
        )?.content?.text;
        if (text?.includes('[notification error]')) {
          throw new Error('display failed');
        }
      });

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
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining('[notification error]'),
            }),
          }),
        });
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/end_turn',
          {
            sessionId: 'test-session-id',
            reason: 'end_turn',
            source: 'background_notification',
          },
        );
      });
    });

    it('flushes notification rewrite metadata even without usage metadata', async () => {
      const flushTurn = vi.fn().mockResolvedValue(undefined);
      const waitForPendingRewrites = vi.fn().mockResolvedValue(undefined);
      const interceptUpdate = vi.fn().mockResolvedValue(undefined);
      session.messageRewriter = {
        interceptUpdate,
        flushTurn,
        waitForPendingRewrites,
      } as unknown as Session['messageRewriter'];
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
                      parts: [{ text: 'notification response' }],
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
        meta: { agentId: string; status: string; toolUseId?: string },
      ) => void;

      callback('done', '<task-notification />', {
        agentId: 'agent-1',
        status: 'completed',
      });

      await vi.waitFor(() => {
        expect(flushTurn).toHaveBeenCalled();
      });
    });

    it('does not enqueue running monitor notifications for model follow-up', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start monitor' }],
      });

      const callback = mockMonitorRegistry.setNotificationCallback.mock
        .calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { monitorId: string; status: string; toolUseId?: string },
      ) => void;

      callback(
        'Monitor "dev server" event #1: ready',
        '<task-notification><status>running</status></task-notification>',
        {
          monitorId: 'monitor-1',
          status: 'running',
          toolUseId: 'tool-1',
        },
      );

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      expect(
        mockChatRecordingService.recordNotification,
      ).not.toHaveBeenCalled();
      expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: expect.objectContaining({
          _meta: expect.objectContaining({
            backgroundTask: expect.objectContaining({
              taskId: 'monitor-1',
              status: 'running',
            }),
          }),
        }),
      });
    });

    it('drains background shell notifications through ACP after the prompt is idle', async () => {
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
                      parts: [{ text: 'The shell finished successfully.' }],
                    },
                  },
                ],
              },
            },
          ]),
        );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'start background shell' }],
      });

      const callback = mockBackgroundShellRegistry.setNotificationCallback.mock
        .calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { shellId: string; status: string },
      ) => void;

      callback(
        'Background shell "npm test" completed.',
        '<task-notification><kind>shell</kind></task-notification>',
        {
          shellId: 'shell-1',
          status: 'completed',
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
              text: '<task-notification><kind>shell</kind></task-notification>',
            },
          ],
          config: { abortSignal: expect.any(AbortSignal) },
        },
        expect.stringMatching(/^test-session-id########notification\d+$/),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Background shell "npm test" completed.',
          },
          _meta: {
            source: 'background_notification',
            qwenDiscreteMessage: true,
            backgroundTask: {
              taskId: 'shell-1',
              status: 'completed',
              kind: 'shell',
              toolUseId: undefined,
            },
          },
        },
      });
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
        sessionId: 'test-session-id',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'The shell finished successfully.',
          },
          _meta: {
            source: 'background_notification_response',
            qwenDiscreteMessage: true,
            backgroundTask: {
              taskId: 'shell-1',
              status: 'completed',
              kind: 'shell',
              toolUseId: undefined,
            },
          },
        },
      });
    });

    it('continues ACP prompt ids after replaying resumed history', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.replayHistory([
        chatRecord({
          uuid: 'user-1',
          promptId: 'test-session-id########1',
          message: { parts: [{ text: '1' }] },
        }),
        chatRecord({
          uuid: 'assistant-1',
          timestamp: '2026-05-17T07:27:18.861Z',
          type: 'assistant',
          promptId: 'test-session-id########1',
          message: { parts: [{ text: 'answer 1' }] },
        }),
        chatRecord({
          uuid: 'user-2',
          timestamp: '2026-05-17T07:27:20.446Z',
          promptId: 'test-session-id########2',
          message: { parts: [{ text: '2' }] },
        }),
      ]);

      await expect(
        session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '3' }],
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
        '3',
      );
      expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledWith(
        'test-session-id########3',
        false,
        expect.any(AbortSignal),
      );
    });

    it('degrades an oversized inline image to a text placeholder before sending to the model', async () => {
      const ENV_KEY = 'QWEN_CODE_MAX_INLINE_MEDIA_BYTES';
      const original = process.env[ENV_KEY];
      process.env[ENV_KEY] = '8';
      try {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=', // ~20 decoded bytes, over the 8-byte cap
            },
          ],
        });

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        const request = sendMessageStream.mock.calls[0]?.[1] as {
          message: Array<Record<string, unknown>>;
        };
        const parts = request.message;
        expect(parts.some((p) => 'inlineData' in p)).toBe(false);
        expect(
          parts.some(
            (p) =>
              typeof p['text'] === 'string' &&
              (p['text'] as string).includes('image/png') &&
              (p['text'] as string).toLowerCase().includes('omitted'),
          ),
        ).toBe(true);
      } finally {
        if (original === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = original;
      }
    });

    describe('conversation_finished telemetry (#4602 review)', () => {
      it('emits conversation_finished once when a turn completes normally', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(finishedSpy).toHaveBeenCalledTimes(1);
      });

      it('still emits conversation_finished when the turn throws (telemetry not lost on the error path)', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        mockChat.sendMessageStream = vi
          .fn()
          .mockRejectedValue(new Error('stream boom'));

        await session
          .prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          })
          .catch(() => undefined);

        expect(finishedSpy).toHaveBeenCalled();
      });
    });

    describe('tool outcome telemetry (#4602 review)', () => {
      it('records a soft tool failure (toolResult.error) as error, not success', async () => {
        const logToolCallSpy = vi
          .spyOn(core, 'logToolCall')
          .mockImplementation(() => {});
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);

        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            execute: vi.fn().mockResolvedValue({
              llmContent: 'nope',
              returnDisplay: 'failed',
              error: { message: 'tool blew up' },
            }),
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
          prompt: [{ type: 'text', text: 'read the file' }],
        });

        const toolEvent = logToolCallSpy.mock.calls
          .map(
            ([, ev]) =>
              ev as {
                function_name?: string;
                status?: string;
                success?: boolean;
              },
          )
          .find((ev) => ev.function_name === 'read_file');
        expect(toolEvent?.status).toBe('error');
        expect(toolEvent?.success).toBe(false);
      });
    });

    describe('auto-compress', () => {
      it('runs automatic compression before sending an ACP prompt', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledWith(
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          0,
        );
      });

      it('uses the current chat after automatic compression replaces it', async () => {
        const compressedChat = {
          sendMessageStream: vi.fn().mockResolvedValue(createEmptyStream()),
          addHistory: vi.fn(),
          getHistory: vi.fn().mockReturnValue([]),
          getHistoryShallow: vi.fn().mockReturnValue([]),
          getLastModelMessageText: vi.fn().mockReturnValue(''),
        } as unknown as GeminiChat;

        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        mockGeminiClient.tryCompressChat.mockImplementation(async () => {
          mockGeminiClient.getChat.mockReturnValue(compressedChat);
          return {
            originalTokenCount: 1000,
            newTokenCount: 200,
            compressionStatus: core.CompressionStatus.COMPRESSED,
          };
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(compressedChat.sendMessageStream).toHaveBeenCalledWith(
          'qwen3-code-plus',
          {
            message: expect.any(Array),
            config: { abortSignal: expect.any(AbortSignal) },
          },
          'test-session-id########1',
        );
      });

      it('emits an ACP-visible update when automatic compression succeeds', async () => {
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 450,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'IMPORTANT: This conversation approached the input token limit for qwen3-code-plus. ' +
                'A compressed context will be sent for future messages (compressed from: 1200 to 450 tokens).',
            },
          },
        });
      });

      it('labels the notice as screenshot-triggered when triggerReason is image_overflow', async () => {
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 450,
          compressionStatus: core.CompressionStatus.COMPRESSED,
          triggerReason: 'image_overflow',
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'IMPORTANT: This conversation accumulated enough tool screenshots to trigger compaction for qwen3-code-plus. ' +
                'A compressed context will be sent for future messages (compressed from: 1200 to 450 tokens).',
            },
          },
        });
      });

      it('continues sending when automatic compression fails', async () => {
        mockGeminiClient.tryCompressChat.mockRejectedValueOnce(
          new Error('compression rate limited'),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledWith(
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledWith(
          'qwen3-code-plus',
          {
            message: expect.any(Array),
            config: { abortSignal: expect.any(AbortSignal) },
          },
          'test-session-id########1',
        );
      });

      it('does not use global UI telemetry when compression fails before local token counts exist', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        vi.spyOn(
          core.uiTelemetryService,
          'getLastPromptTokenCount',
        ).mockReturnValue(101);
        mockGeminiClient.tryCompressChat.mockRejectedValueOnce(
          new Error('compression rate limited'),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'agent_message_chunk',
              content: expect.objectContaining({
                text: expect.stringContaining('Session token limit exceeded'),
              }),
            }),
          }),
        );
      });

      it('returns cancelled when automatic compression is aborted', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockImplementation(
          async (_promptId: string, _force: boolean, signal: AbortSignal) =>
            new Promise((_, reject) => {
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

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await vi.waitFor(() => {
          expect(mockGeminiClient.tryCompressChat).toHaveBeenCalled();
        });

        await session.cancelPendingPrompt();

        await expect(promptPromise).resolves.toEqual({
          stopReason: 'cancelled',
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: expect.any(Array),
        });
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
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

      it('uses compression token info instead of global UI telemetry for the session limit', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        vi.spyOn(
          core.uiTelemetryService,
          'getLastPromptTokenCount',
        ).mockReturnValue(999);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('falls back to the previous prompt token count when compression returns zero token info', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValue({
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
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
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('falls back to the previous prompt token count when compressed token info is zero', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 1200,
            newTokenCount: 0,
            compressionStatus: core.CompressionStatus.COMPRESSED,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
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
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'first' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'second' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('records prompt token count instead of total token count for later session-limit checks', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockRejectedValueOnce(new Error('compression unavailable'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  usageMetadata: {
                    totalTokenCount: 500,
                    promptTokenCount: 50,
                  },
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'long response' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'next prompt' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });

      it('resets the session-local token count when the active chat instance changes', async () => {
        const clearedChat = {
          sendMessageStream: vi.fn().mockResolvedValue(createEmptyStream()),
          addHistory: vi.fn(),
          getHistory: vi.fn().mockReturnValue([]),
          getHistoryShallow: vi.fn().mockReturnValue([]),
          getLastModelMessageText: vi.fn().mockReturnValue(''),
        } as unknown as GeminiChat;
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockRejectedValueOnce(new Error('compression unavailable'));
        mockChat.sendMessageStream = vi.fn().mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                usageMetadata: {
                  totalTokenCount: 500,
                  promptTokenCount: 101,
                },
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'before clear' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        mockGeminiClient.getChat.mockReturnValue(clearedChat);

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'after clear' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(clearedChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('continues sending when the compression notification fails', async () => {
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 450,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockClient.sessionUpdate = vi
          .fn()
          .mockResolvedValueOnce(undefined) // emitUserMessage
          .mockRejectedValueOnce(new Error('client disconnected'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('stops before sending when the compressed prompt exceeds the session token limit', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 1200,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.COMPRESSED,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'IMPORTANT: This conversation approached the input token limit for qwen3-code-plus. ' +
                'A compressed context will be sent for future messages (compressed from: 1200 to 101 tokens).',
            },
          },
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

      it('stops without throwing when the token-limit diagnostic fails', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 101,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockClient.sessionUpdate = vi
          .fn()
          .mockResolvedValueOnce(undefined) // emitUserMessage
          .mockRejectedValueOnce(new Error('client disconnected'));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockChat.addHistory).not.toHaveBeenCalled();
      });

      it('also runs automatic compression before tool response follow-up sends', async () => {
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

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('injects drained mid-turn user messages with tool responses', async () => {
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
        mockClient.extMethod = vi.fn().mockResolvedValue({
          messages: ['please also check tests'],
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

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'read file' }],
        });

        expect(mockClient.extMethod).toHaveBeenCalledWith(
          'craft/drainMidTurnQueue',
          { sessionId: 'test-session-id' },
        );
        const secondCall = vi.mocked(mockChat.sendMessageStream).mock.calls[1];
        const midTurnPart = {
          text: '\n[User message received during tool execution]: please also check tests',
        };
        expect(secondCall?.[1].message).toEqual(
          expect.arrayContaining([midTurnPart]),
        );
        expect(
          mockChatRecordingService.recordMidTurnUserMessage,
        ).toHaveBeenCalledWith([midTurnPart], 'please also check tests');
      });

      it('latches mid-turn drain off after a permanent (-32601) error', async () => {
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: vi
              .fn()
              .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
          }),
        };
        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        // The ACP SDK rejects with a raw JSON-RPC error object, not an Error.
        mockClient.extMethod = vi
          .fn()
          .mockRejectedValue({ code: -32601, message: 'Method not found' });

        const toolCallStream = () =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'c',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream());

        const prompt = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text' as const, text: 'read file' }],
        };
        await session.prompt(prompt);
        await session.prompt(prompt);

        // After the permanent error the latch trips, so the drain extMethod is
        // attempted only on the first tool batch, not the second.
        const drainCalls = vi
          .mocked(mockClient.extMethod)
          .mock.calls.filter((call) => call[0] === 'craft/drainMidTurnQueue');
        expect(drainCalls).toHaveLength(1);
      });

      it('latches mid-turn drain off after repeated timeouts when the client never responds', async () => {
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: vi
              .fn()
              .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
          }),
        };
        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        // A non-conforming client that silently drops unknown methods: the
        // drain request never settles. The turn must not hang on it.
        mockClient.extMethod = vi.fn().mockReturnValue(new Promise(() => {}));

        const toolCallStream = () =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'c',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]);
        // Four prompts, each with one tool batch. The first three time out
        // (consecutive-strike budget), the fourth must skip the drain.
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream());

        const prompt = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text' as const, text: 'read file' }],
        };
        await session.prompt(prompt);
        await session.prompt(prompt);
        await session.prompt(prompt);
        await session.prompt(prompt);

        // Three consecutive timeouts trip the latch, so the never-answered
        // extMethod is attempted on the first three tool batches only.
        const drainCalls = vi
          .mocked(mockClient.extMethod)
          .mock.calls.filter((call) => call[0] === 'craft/drainMidTurnQueue');
        expect(drainCalls).toHaveLength(3);
      }, 20_000);

      it('resets the timeout strike count when a drain succeeds', async () => {
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: vi
              .fn()
              .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
          }),
        };
        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        // Timeout, success, then timeouts: the success must reset the strike
        // count, so the latch needs three NEW consecutive timeouts to trip.
        mockClient.extMethod = vi
          .fn()
          .mockReturnValueOnce(new Promise(() => {}))
          .mockResolvedValueOnce({ messages: [] })
          .mockReturnValue(new Promise(() => {}));

        const toolCallStream = () =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'c',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]);
        const streamMock = vi.fn();
        for (let i = 0; i < 5; i++) {
          streamMock
            .mockResolvedValueOnce(toolCallStream())
            .mockResolvedValueOnce(createEmptyStream());
        }
        mockChat.sendMessageStream = streamMock;

        const prompt = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text' as const, text: 'read file' }],
        };
        for (let i = 0; i < 5; i++) {
          await session.prompt(prompt);
        }

        // Strikes: timeout(1), success(reset to 0), timeout(1), timeout(2),
        // timeout(3 -> latch). All five batches attempt the drain; without
        // the reset the latch would trip on the fourth batch and the fifth
        // attempt would be skipped.
        const drainCalls = vi
          .mocked(mockClient.extMethod)
          .mock.calls.filter((call) => call[0] === 'craft/drainMidTurnQueue');
        expect(drainCalls).toHaveLength(5);
      }, 30_000);

      it('keeps mid-turn drain enabled after a transient error', async () => {
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: vi
              .fn()
              .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
          }),
        };
        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockClient.extMethod = vi
          .fn()
          .mockRejectedValue({ code: -32000, message: 'temporary failure' });

        const toolCallStream = () =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'c',
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                ],
              },
            },
          ]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(toolCallStream())
          .mockResolvedValueOnce(createEmptyStream());

        const prompt = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text' as const, text: 'read file' }],
        };
        await session.prompt(prompt);
        await session.prompt(prompt);

        // A transient error must NOT latch: the drain is retried on the second
        // tool batch.
        const drainCalls = vi
          .mocked(mockClient.extMethod)
          .mock.calls.filter((call) => call[0] === 'craft/drainMidTurnQueue');
        expect(drainCalls).toHaveLength(2);
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
        mockGeminiClient.tryCompressChat
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
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
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
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
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
        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockGeminiClient.tryCompressChat).not.toHaveBeenCalledWith(
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
        mockGeminiClient.tryCompressChat
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
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
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
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          1,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockGeminiClient.tryCompressChat,
          sendMessageStream,
          1,
        );
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
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockGeminiClient.tryCompressChat
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
          expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        });

        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(mockGeminiClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
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
        expect(scheduler.stop).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Cron jobs disabled for the rest of this session due to token limit. Restart the session to re-enable.',
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

        expect(mockGeminiClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(tokenLimitDiagnosticCount()).toBe(diagnosticCountBefore);
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

        expect(mockGeminiClient.tryCompressChat).not.toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
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
          paths: [fileName],
          signal: expect.any(AbortSignal),
        });
      } finally {
        readManyFilesSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
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
      expect(invocation.params).toEqual({ path: '/tmp/updated.txt' });
      expect(executeSpy).toHaveBeenCalled();
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
      mockConfig.getGeminiClient = vi
        .fn()
        .mockReturnValue({ ...mockGeminiClient, getHistoryTail });
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
      mockConfig.getGeminiClient = vi
        .fn()
        .mockReturnValue({ ...mockGeminiClient, getHistoryTail });
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
      mockConfig.getGeminiClient = vi
        .fn()
        .mockReturnValue({ ...mockGeminiClient, getHistoryTail });
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
      mockConfig.getAutoModeDenialState = vi.fn().mockReturnValue({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 20,
        totalUnavailable: 0,
      });
      mockConfig.setAutoModeDenialState = setAutoModeDenialState;
      (
        mockGeminiClient as unknown as {
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
          );
        });

        it('forwards classifier_unavailable reasons to PermissionDenied hooks', async () => {
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
              kind: 'blocked',
              errorMessage: 'blocked',
              reason: 'classifier_unavailable',
            },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            new AbortController().signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).toHaveBeenCalledWith(
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            'classifier_unavailable',
            expect.any(AbortSignal),
          );
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
                stop_hook_active: true,
                last_assistant_message: 'response text',
              }),
            }),
            expect.anything(),
          );
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
      });

      describe('PreToolUse hook', () => {
        it('fires PreToolUse hook before tool execution', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
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

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PreToolUse',
              input: expect.objectContaining({
                tool_name: 'read_file',
                tool_input: { path: '/tmp/test.txt' },
              }),
            }),
            expect.anything(),
          );
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
      });

      describe('PostToolUse hook', () => {
        it('fires PostToolUse hook after successful tool execution', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
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
        });

        it('stops execution when PostToolUse hook returns shouldStop', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { shouldStop: true, reason: 'Stopping per hook request' },
            }),
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
        });
      });

      describe('PostToolUseFailure hook', () => {
        it('fires PostToolUseFailure hook when tool execution fails', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
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
        });
      });

      describe('StopFailure hook', () => {
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
  });

  describe('dispose', () => {
    type SessionInternals = {
      notificationQueue: unknown[];
      cronQueue: string[];
      notificationProcessing: boolean;
      disposed: boolean;
    };

    it('clears notification and cron queues, marks disposed, and unregisters callbacks', () => {
      const internals = session as unknown as SessionInternals;
      internals.notificationQueue.push({ taskId: 'stale' });
      internals.cronQueue.push('stale-cron-prompt');
      internals.notificationProcessing = true;
      expect(internals.disposed).toBe(false);

      session.dispose();

      expect(internals.disposed).toBe(true);
      expect(internals.notificationQueue).toHaveLength(0);
      expect(internals.cronQueue).toHaveLength(0);
      expect(internals.notificationProcessing).toBe(false);
      expect(
        mockBackgroundTaskRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockMonitorRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
      expect(
        mockBackgroundShellRegistry.setNotificationCallback,
      ).toHaveBeenLastCalledWith(undefined);
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

      // The generator received an AbortSignal so the daemon can cancel
      // mid-flight if the next prompt arrives first.
      expect(generateMock).toHaveBeenCalledWith(
        mockConfig,
        expect.any(Array),
        expect.any(AbortSignal),
        expect.objectContaining({ enableCacheSharing: expect.any(Boolean) }),
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

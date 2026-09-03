/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
  useResumeCommand,
} from './useResumeCommand.js';
import { useHistory } from './useHistoryManager.js';
import {
  makeSwapSlotClient,
  type SwapSlotClient,
} from '../../test-utils/mock-swap-slot-client.js';

import type { Content } from '@google/genai';
import type { LoadedSettings } from '../../config/settings.js';

const mockSettings = {
  merged: {
    ui: {
      history: {
        collapseOnResume: false,
      },
    },
  },
} as unknown as LoadedSettings;

/** Minimal Config mock shaped like the other failure tests in this file. */
function makeSwapSlotConfig(llmClient: SwapSlotClient) {
  return {
    getSessionId: () => 'old-session-id',
    getTargetDir: () => '/tmp',
    getLlmClient: () => llmClient,
    startNewSession: vi.fn(),
    getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
    getBackgroundTaskRegistry: () => ({
      hasRunningTasks: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
    }),
    getBackgroundShellRegistry: () => ({
      getAll: vi.fn().mockReturnValue([]),
      hasRunningEntries: vi.fn().mockReturnValue(false),
      reset: vi.fn(),
    }),
    getMonitorRegistry: () => ({
      getRunning: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
    }),
    getWorkflowRunRegistry: () => ({
      hasRunningEntries: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      listStartingRunIds: vi.fn().mockReturnValue([]),
      reset: vi.fn(),
      abortAll: vi.fn(),
    }),
    loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
    getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
    getDebugLogger: () => ({
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  } as unknown as import('@qwen-code/qwen-code-core').Config;
}

const resumeMocks = vi.hoisted(() => {
  let resolveLoadSession:
    | ((value: { conversation: unknown } | undefined) => void)
    | undefined;
  let rejectLoadSession: ((error: Error) => void) | undefined;
  let pendingLoadSession:
    | Promise<{ conversation: unknown } | undefined>
    | undefined;

  return {
    makeConversation(messages: Content[]) {
      return {
        sessionId: 'session-1',
        projectHash: 'project-1',
        startTime: '2026-07-11T00:00:00.000Z',
        lastUpdated: '2026-07-11T00:00:00.000Z',
        messages: messages.map((message, index) => ({
          uuid: `m-${index}`,
          parentUuid: index === 0 ? null : `m-${index - 1}`,
          sessionId: 'session-1',
          timestamp: '2026-07-11T00:00:00.000Z',
          type: message.role === 'model' ? 'assistant' : 'user',
          cwd: '/tmp/project',
          version: 'test',
          message,
        })),
      };
    },
    createPendingLoadSession() {
      pendingLoadSession = new Promise((resolve, reject) => {
        resolveLoadSession = resolve;
        rejectLoadSession = reject;
      });
      return pendingLoadSession;
    },
    resolvePendingLoadSession(value: { conversation: unknown } | undefined) {
      resolveLoadSession?.(value);
    },
    rejectPendingLoadSession(error: Error) {
      rejectLoadSession?.(error);
    },
    getPendingLoadSession() {
      return pendingLoadSession;
    },
    reset() {
      resolveLoadSession = undefined;
      rejectLoadSession = undefined;
      pendingLoadSession = undefined;
    },
  };
});

vi.mock('../utils/resumeHistoryUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/resumeHistoryUtils.js')>();
  return {
    ...actual,
    buildResumedHistoryItems: vi.fn(() => [
      { id: 1, type: 'user', text: 'hi' },
    ]),
  };
});

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  class SessionService {
    constructor(_cwd: string) {}
    async loadSession(_sessionId: string) {
      return (
        resumeMocks.getPendingLoadSession() ??
        Promise.resolve({
          conversation: resumeMocks.makeConversation([
            { role: 'user', parts: [{ text: 'hello' }] },
          ]),
        })
      );
    }
    getSessionTitle(_sessionId: string) {
      return undefined;
    }
  }

  return {
    ...original,
    SessionService,
  };
});

describe('useResumeCommand', () => {
  it('should initialize with dialog closed', () => {
    const { result } = renderHook(() =>
      useResumeCommand({
        settings: mockSettings,
        config: null,
        historyManager: {
          addItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
      }),
    );

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should open the dialog when openResumeDialog is called', () => {
    const { result } = renderHook(() =>
      useResumeCommand({
        settings: mockSettings,
        config: null,
        historyManager: {
          addItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
      }),
    );

    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);
  });

  it('should close the dialog when closeResumeDialog is called', () => {
    const { result } = renderHook(() =>
      useResumeCommand({
        settings: mockSettings,
        config: null,
        historyManager: {
          addItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        },
        startNewSession: vi.fn(),
      }),
    );

    // Open the dialog first
    act(() => {
      result.current.openResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(true);

    // Close the dialog
    act(() => {
      result.current.closeResumeDialog();
    });

    expect(result.current.isResumeDialogOpen).toBe(false);
  });

  it('should maintain stable function references across renders', () => {
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const { result, rerender } = renderHook(() =>
      useResumeCommand({
        settings: mockSettings,
        config: null,
        historyManager,
        startNewSession,
      }),
    );

    const initialOpenFn = result.current.openResumeDialog;
    const initialCloseFn = result.current.closeResumeDialog;
    const initialHandleResume = result.current.handleResume;

    rerender();

    expect(result.current.openResumeDialog).toBe(initialOpenFn);
    expect(result.current.closeResumeDialog).toBe(initialCloseFn);
    expect(result.current.handleResume).toBe(initialHandleResume);
  });

  it('handleResume no-ops when config is null', async () => {
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const { result } = renderHook(() =>
      useResumeCommand({
        config: null,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('session-1');
    });

    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
  });

  it('handleResume closes the dialog immediately and restores session state', async () => {
    resumeMocks.reset();
    resumeMocks.createPendingLoadSession();

    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();
    const clearPendingState = vi.fn();
    const llmClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    const resetMonitorRegistry = vi.fn();

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => llmClient,
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: resetMonitorRegistry,
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
      getBackgroundAgentResumeService: () => ({
        buildRecoveredBackgroundAgentsNotice: vi.fn(),
      }),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
        clearPendingState,
      }),
    );

    // Open first so we can verify the dialog closes immediately.
    act(() => {
      result.current.openResumeDialog();
    });
    expect(result.current.isResumeDialogOpen).toBe(true);

    let resumePromise: Promise<void> | undefined;
    act(() => {
      // Start resume but do not await it yet — we want to assert the dialog
      // closes immediately before the async session load completes.
      resumePromise = result.current.handleResume('session-2');
    });
    expect(result.current.isResumeDialogOpen).toBe(false);

    // Now finish the async load and let the handler complete.
    resumeMocks.resolvePendingLoadSession({
      conversation: resumeMocks.makeConversation([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]),
    });
    await act(async () => {
      await resumePromise;
    });

    expect(config.startNewSession).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({
        conversation: expect.anything(),
      }),
    );
    expect(startNewSession).toHaveBeenCalledWith('session-2');
    expect(llmClient.initialize).toHaveBeenCalledTimes(1);
    expect(llmClient.initialize).toHaveBeenCalledWith();
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
    expect(historyManager.loadHistory).toHaveBeenCalledTimes(1);
    expect(clearPendingState).toHaveBeenCalledTimes(1);
    expect(clearPendingState.mock.invocationCallOrder[0]).toBeLessThan(
      historyManager.loadHistory.mock.invocationCallOrder[0]!,
    );
    expect(resetMonitorRegistry).toHaveBeenCalledTimes(1);
    expect(config.getGoalRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('handleResume routes history replacement through the loadHistory override', async () => {
    resumeMocks.reset();
    resumeMocks.createPendingLoadSession();

    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const overrideLoadHistory = vi.fn();

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => ({
        initialize: vi.fn().mockResolvedValue(undefined),
      }),
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
      getBackgroundAgentResumeService: () => ({
        buildRecoveredBackgroundAgentsNotice: vi.fn(),
      }),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        // AppContainer passes its latch-reconciling wrapper here; the
        // rebuilt history must flow through it, not the raw manager.
        loadHistory: overrideLoadHistory,
        startNewSession: vi.fn(),
      }),
    );

    resumeMocks.resolvePendingLoadSession({
      conversation: resumeMocks.makeConversation([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]),
    });
    await act(async () => {
      await result.current.handleResume('session-2');
    });

    expect(overrideLoadHistory).toHaveBeenCalledTimes(1);
    expect(overrideLoadHistory).toHaveBeenCalledWith(
      expect.arrayContaining([expect.anything()]),
    );
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
    expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
  });

  it('adds a recovery notice when resuming an interrupted tool turn', async () => {
    resumeMocks.reset();
    resumeMocks.createPendingLoadSession();

    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();
    const llmClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => llmClient,
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
      getBackgroundAgentResumeService: () => ({
        buildRecoveredBackgroundAgentsNotice: vi.fn(),
      }),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    const resumePromise = result.current.handleResume('session-2');
    resumeMocks.resolvePendingLoadSession({
      conversation: resumeMocks.makeConversation([
        { role: 'user', parts: [{ text: 'read file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: 'a.txt' },
              },
            },
          ],
        },
      ]),
    });
    await act(async () => {
      await resumePromise;
    });

    expect(historyManager.loadHistory).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'info',
          text: expect.stringContaining('stopped during tool execution'),
        }),
      ]),
    );
  });

  it('applies collapseOnResume policy when resuming a session', async () => {
    const startNewSession = vi.fn();
    const llmClient = {
      initialize: vi.fn(),
    };
    const resetMonitorRegistry = vi.fn();

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => llmClient,
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: resetMonitorRegistry,
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const settingsWithCollapse = {
      merged: {
        ui: {
          history: {
            collapseOnResume: true,
          },
        },
      },
    } as unknown as LoadedSettings;

    const { result } = renderHook(() => {
      const historyManager = useHistory();
      const resumeCommand = useResumeCommand({
        config,
        settings: settingsWithCollapse,
        historyManager,
        startNewSession,
      });
      return { historyManager, resumeCommand };
    });

    let resumePromise: Promise<void> | undefined;
    act(() => {
      resumePromise = result.current.resumeCommand.handleResume('session-3');
    });

    resumeMocks.resolvePendingLoadSession({
      conversation: resumeMocks.makeConversation([
        { role: 'user', parts: [{ text: 'hello' }] },
      ]),
    });
    await act(async () => {
      await resumePromise;
    });

    // Verify that the history state contains the suppressed item and the summary item
    const history = result.current.historyManager.history;
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          display: expect.objectContaining({ suppressOnRestore: true }),
        }),
        expect.objectContaining({
          display: expect.objectContaining({ kind: 'collapse-summary' }),
        }),
      ]),
    );
  });

  it('adds a recovered-background-agents notice when paused agents are restored', async () => {
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();
    const llmClient = {
      initialize: vi.fn(),
    };
    const buildRecoveredBackgroundAgentsNotice = vi
      .fn()
      .mockReturnValue('Recovered 2 interrupted background agents.');

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => llmClient,
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue({}),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi
        .fn()
        .mockResolvedValue([{ agentId: 'a' }, { agentId: 'b' }]),
      getBackgroundAgentResumeService: () => ({
        buildRecoveredBackgroundAgentsNotice,
      }),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('session-3');
    });

    expect(config.loadPausedBackgroundAgents).toHaveBeenCalledWith('session-3');
    expect(buildRecoveredBackgroundAgentsNotice).toHaveBeenCalledWith(2);
    expect(historyManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: 'Recovered 2 interrupted background agents.',
      }),
      expect.any(Number),
    );
  });

  it('blocks resume when the current session still has running background work', async () => {
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const config = {
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(true),
        getAll: vi.fn().mockReturnValue([
          {
            agentId: 'bg_ab12cd34',
            isBackgrounded: true,
            status: 'running',
            description: 'long-running research',
            startTime: Date.now(),
          },
        ]),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      getTargetDir: () => '/tmp',
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    act(() => {
      result.current.openResumeDialog();
    });

    await act(async () => {
      await result.current.handleResume('session-blocked');
    });

    expect(result.current.isResumeDialogOpen).toBe(false);
    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
    expect(historyManager.addItem).toHaveBeenCalledTimes(1);
    const blockedItem = historyManager.addItem.mock.calls[0]?.[0] as {
      type: string;
      text: string;
    };
    expect(blockedItem.type).toBe('error');
    expect(blockedItem.text).toContain(BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE);
    expect(blockedItem.text).toContain('[bg_ab12cd34]');
  });

  it('blocks resume when the current session still has a running monitor', async () => {
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const config = {
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        getAll: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([
          {
            monitorId: 'mon_123',
            status: 'running',
            description: 'tail -f /var/log/app.log',
            startTime: Date.now(),
          },
        ]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      getTargetDir: () => '/tmp',
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    act(() => {
      result.current.openResumeDialog();
    });

    await act(async () => {
      await result.current.handleResume('session-blocked');
    });

    expect(result.current.isResumeDialogOpen).toBe(false);
    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
    expect(historyManager.addItem).toHaveBeenCalledTimes(1);
    const blockedItem = historyManager.addItem.mock.calls[0]?.[0] as {
      type: string;
      text: string;
    };
    expect(blockedItem.type).toBe('error');
    expect(blockedItem.text).toContain(BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE);
    expect(blockedItem.text).toContain('[mon_123]');
  });

  it('rolls core back when persisted Goal state is malformed', async () => {
    resumeMocks.reset();
    const startNewSession = vi.fn();
    const llmClient = makeSwapSlotClient();
    const goalFailure = new Error('unsupported Goal lifecycle record');

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getLlmClient: () => llmClient,
      startNewSession: vi.fn(),
      getGoalRuntimeReady: vi.fn().mockRejectedValue(goalFailure),
      getBackgroundTaskRegistry: () => ({
        hasRunningTasks: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        getAll: vi.fn().mockReturnValue([]),
        hasRunningEntries: vi.fn().mockReturnValue(false),
        reset: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        getRunning: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
      }),
      getWorkflowRunRegistry: () => ({
        hasRunningEntries: vi.fn().mockReturnValue(false),
        list: vi.fn().mockReturnValue([]),
        listStartingRunIds: vi.fn().mockReturnValue([]),
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents: vi.fn().mockResolvedValue([]),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('new-session-id');
    });

    // Core was swapped to the new session, then rolled back to the old one
    // with its persisted state reloaded for the rollback re-initialize.
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      1,
      'new-session-id',
      expect.any(Object),
    );
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      2,
      'old-session-id',
      expect.objectContaining({ conversation: expect.anything() }),
    );
    expect(config.loadPausedBackgroundAgents).toHaveBeenCalledWith(
      'old-session-id',
    );
    // UI never swapped.
    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
    // User sees the failure.
    expect(historyManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /Failed to resume session.*unsupported Goal lifecycle record/,
        ),
      }),
      expect.any(Number),
    );
    // The forward initialize never ran (the Goal runtime rejected before
    // it); the single call is the rollback's re-initialize of the old
    // session, which re-hydrates the client against the restored session
    // the same way /branch's rollback does (#9844 review).
    expect(llmClient.initialize).toHaveBeenCalledTimes(1);
    // The rollback aborted the transaction this attempt opened. The return
    // value is deliberately NOT asserted: the failure landed before the
    // forward initialize(), so the real client armed nothing and returns
    // false here ("abort with an open but unarmed transaction is a no-op"
    // in client.telemetrySwap.test.ts) — the slot fake over-approximates
    // that case (see mock-swap-slot-client.ts). The load-bearing hook
    // invariants: abort ran exactly once and commit never did.
    expect(llmClient.abortTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(llmClient.commitTelemetrySwap).not.toHaveBeenCalled();
  });

  it('re-initializes the outgoing session when resume fails after initialize', async () => {
    // The swap fails AFTER the forward initialize() replayed the incoming
    // session (here: background-agent recovery rejects). Rolling core back
    // must re-initialize the client against the outgoing session — the same
    // shape as /branch's rollback. Without it the client's chat stays on
    // the abandoned session's replayed history and the abort clears
    // initializedSessionId, so a follow-up same-session /resume of the
    // outgoing session skips initialize()'s early return: its replay wipes
    // the outgoing session's live bucket (skill invocations are never
    // persisted) and re-adds its stored telemetry on top of the aggregate
    // that already contains it — the #9833 double-count reintroduced
    // (#9844 review).
    resumeMocks.reset();

    const llmClient = makeSwapSlotClient();
    const resumeFailure = new Error('background agent recovery failed');
    const config = {
      ...makeSwapSlotConfig(llmClient),
      loadPausedBackgroundAgents: vi
        .fn()
        .mockRejectedValueOnce(resumeFailure)
        .mockResolvedValue([]),
    } as unknown as import('@qwen-code/qwen-code-core').Config;
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('new-session-id');
    });

    // The failure surfaced...
    expect(historyManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /Failed to resume session.*background agent recovery failed/,
        ),
      }),
      expect.any(Number),
    );
    // Core was swapped to the new session, then rolled back to the old one
    // with its persisted state reloaded for the re-initialize.
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      1,
      'new-session-id',
      expect.any(Object),
    );
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      2,
      'old-session-id',
      expect.objectContaining({ conversation: expect.anything() }),
    );
    // The forward initialize ran, and the rollback re-initialized the
    // outgoing session (a reverted fix leaves the call count at 1).
    expect(llmClient.initialize).toHaveBeenCalledTimes(2);
    // The outgoing session's paused agents were reloaded after rollback.
    expect(config.loadPausedBackgroundAgents).toHaveBeenCalledWith(
      'old-session-id',
    );
    // UI never swapped.
    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.clearItems).not.toHaveBeenCalled();
    expect(historyManager.loadHistory).not.toHaveBeenCalled();
    // The rollback aborted the armed transaction and never committed it.
    // The true return is safe to assert here: the forward initialize ran,
    // so the real client armed its undo and also returns true.
    expect(llmClient.abortTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(llmClient.abortTelemetrySwap).toHaveReturnedWith(true);
    expect(llmClient.commitTelemetrySwap).not.toHaveBeenCalled();

    // The released slot admits the follow-up same-session resume of the
    // outgoing session (the double-count trigger): it is NOT rejected with
    // "already in progress" and settles cleanly.
    await act(async () => {
      await result.current.handleResume('old-session-id');
    });
    expect(llmClient.beginTelemetrySwap).toHaveBeenCalledTimes(2);
    expect(historyManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
  });

  it('settles the swap slot when resume fails before the core swap', async () => {
    // The latch opens BEFORE the incoming session loads. If that pre-core-
    // swap work rejects, the catch must still settle the transaction this
    // attempt opened — forgetting the settle leaves the single slot
    // occupied and every later swap rejected with "already in progress"
    // (#9844).
    resumeMocks.reset();
    resumeMocks.createPendingLoadSession();

    const llmClient = makeSwapSlotClient();
    const config = makeSwapSlotConfig(llmClient);
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
    };
    const startNewSession = vi.fn();

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    let resumePromise: Promise<void> | undefined;
    act(() => {
      resumePromise = result.current.handleResume('session-2');
    });
    await act(async () => {
      resumeMocks.rejectPendingLoadSession(new Error('session load failed'));
      await resumePromise;
    });

    // The failure surfaced, and nothing swapped.
    expect(config.startNewSession).not.toHaveBeenCalled();
    expect(startNewSession).not.toHaveBeenCalled();
    expect(historyManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /Failed to resume session.*session load failed/,
        ),
      }),
      expect.any(Number),
    );
    // The catch settled (committed, never aborted) the transaction this
    // attempt opened.
    expect(llmClient.commitTelemetrySwap).toHaveBeenCalledTimes(1);
    expect(llmClient.abortTelemetrySwap).not.toHaveBeenCalled();

    // The released slot admits the next swap: it is NOT rejected with
    // "already in progress" and completes the full swap.
    resumeMocks.reset();
    await act(async () => {
      await result.current.handleResume('session-2');
    });
    expect(llmClient.beginTelemetrySwap).toHaveBeenCalledTimes(2);
    expect(historyManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
    expect(config.startNewSession).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({ conversation: expect.anything() }),
    );
  });

  it('settles the swap slot when resume fails after the UI commit', async () => {
    // Once the UI swap commits, a later failure (here: loadHistory) must
    // not roll core back or abort the committed replay — the catch settles
    // the transaction on top of the forward commit instead (#9844).
    resumeMocks.reset();

    const llmClient = makeSwapSlotClient();
    const config = makeSwapSlotConfig(llmClient);
    const loadHistory = vi.fn().mockImplementation(() => {
      throw new Error('history items failed after commit');
    });
    const historyManager = {
      addItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory,
    };
    const startNewSession = vi.fn();

    const { result } = renderHook(() =>
      useResumeCommand({
        config,
        settings: mockSettings,
        historyManager,
        startNewSession,
      }),
    );

    await act(async () => {
      await result.current.handleResume('session-2');
    });

    // The failure surfaced...
    expect(historyManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringMatching(
          /Failed to resume session.*history items failed after commit/,
        ),
      }),
      expect.any(Number),
    );
    // ...but the swap stands: UI swapped, core did NOT roll back (a second
    // startNewSession call with the old id would be the rollback).
    expect(startNewSession).toHaveBeenCalledTimes(1);
    expect(startNewSession).toHaveBeenCalledWith('session-2');
    expect(config.startNewSession).toHaveBeenCalledTimes(1);
    // Never an abort (which would drop the committed session's replay), and
    // the catch's settle ran on top of the forward commit.
    expect(llmClient.abortTelemetrySwap).not.toHaveBeenCalled();
    expect(llmClient.commitTelemetrySwap).toHaveBeenCalledTimes(2);

    // The slot is free for the next swap: NOT rejected with "already in
    // progress".
    loadHistory.mockReset();
    await act(async () => {
      await result.current.handleResume('session-2');
    });
    expect(llmClient.beginTelemetrySwap).toHaveBeenCalledTimes(2);
    expect(historyManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('already in progress'),
      }),
      expect.any(Number),
    );
  });
});

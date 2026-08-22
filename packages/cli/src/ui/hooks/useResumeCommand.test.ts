/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import {
  BACKGROUND_WORK_SWITCH_BLOCKED_MESSAGE,
  useResumeCommand,
} from './useResumeCommand.js';
import { useHistory } from './useHistoryManager.js';

import { uiTelemetryService } from '@qwen-code/qwen-code-core';

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

const resumeMocks = vi.hoisted(() => {
  let resolveLoadSession:
    | ((value: { conversation: unknown } | undefined) => void)
    | undefined;
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
      pendingLoadSession = new Promise((resolve) => {
        resolveLoadSession = resolve;
      });
      return pendingLoadSession;
    },
    resolvePendingLoadSession(value: { conversation: unknown } | undefined) {
      resolveLoadSession?.(value);
    },
    getPendingLoadSession() {
      return pendingLoadSession;
    },
    reset() {
      resolveLoadSession = undefined;
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
    const geminiClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    const resetMonitorRegistry = vi.fn();

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
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
    expect(geminiClient.initialize).toHaveBeenCalledTimes(1);
    expect(geminiClient.initialize).toHaveBeenCalledWith();
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
      getGeminiClient: () => ({
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
    const geminiClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
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
    const geminiClient = {
      initialize: vi.fn(),
    };
    const resetMonitorRegistry = vi.fn();

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
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
    const geminiClient = {
      initialize: vi.fn(),
    };
    const buildRecoveredBackgroundAgentsNotice = vi
      .fn()
      .mockReturnValue('Recovered 2 interrupted background agents.');

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
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
    const startNewSession = vi.fn();
    const geminiClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    const goalFailure = new Error('unsupported Goal lifecycle record');

    const config = {
      getSessionId: () => 'old-session-id',
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
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

    // Core was swapped to the new session, then rolled back to the old one.
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      1,
      'new-session-id',
      expect.any(Object),
    );
    expect(config.startNewSession).toHaveBeenNthCalledWith(
      2,
      'old-session-id',
      undefined,
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
    expect(geminiClient.initialize).not.toHaveBeenCalled();
  });

  function resumeConfigForTelemetry(overrides: {
    loadPausedBackgroundAgents?: ReturnType<typeof vi.fn>;
    geminiClient?: { initialize: ReturnType<typeof vi.fn> };
    getSessionId?: () => string;
    startNewSession?: ReturnType<typeof vi.fn>;
  }) {
    const geminiClient = overrides.geminiClient ?? {
      initialize: vi.fn().mockResolvedValue(undefined),
    };
    const config = {
      getSessionId: overrides.getSessionId ?? (() => 'old-session-id'),
      getTargetDir: () => '/tmp',
      getGeminiClient: () => geminiClient,
      startNewSession: overrides.startNewSession ?? vi.fn(),
      getGoalRuntimeReady: vi.fn().mockResolvedValue(undefined),
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
        reset: vi.fn(),
        abortAll: vi.fn(),
      }),
      loadPausedBackgroundAgents:
        overrides.loadPausedBackgroundAgents ?? vi.fn().mockResolvedValue([]),
      getChatRecordingService: () => ({ rebuildTurnBoundaries: vi.fn() }),
      getDebugLogger: () => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;
    return { config, geminiClient };
  }

  it('restores the usage aggregate when a resume fails after client init', async () => {
    const snapshot = { sessionId: 'new-session-id' } as never;
    const snapshotForReplay = vi
      .spyOn(uiTelemetryService, 'snapshotForReplay')
      .mockReturnValue(snapshot);
    const restoreFromReplaySnapshot = vi
      .spyOn(uiTelemetryService, 'restoreFromReplaySnapshot')
      .mockImplementation(() => {});
    // Fails after initialize() has already replayed the incoming session's
    // stored telemetry into the process-wide aggregate.
    const loadPausedBackgroundAgents = vi
      .fn()
      .mockRejectedValueOnce(new Error('agent sidecar unreadable'))
      .mockResolvedValue([]);
    const { config, geminiClient } = resumeConfigForTelemetry({
      loadPausedBackgroundAgents,
    });
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

    expect(geminiClient.initialize).toHaveBeenCalledTimes(2);
    expect(snapshotForReplay).toHaveBeenCalledWith('new-session-id');
    // Without this the abandoned session's whole history stays in the
    // aggregate that persistSessionUsage writes out.
    expect(restoreFromReplaySnapshot).toHaveBeenCalledWith(snapshot);
    // Ordering is load-bearing: the rollback's re-initialize() replays the
    // old session's history into the aggregate again, so restoring before it
    // would be undone and leave the old session double-counted.
    const restoreOrder = restoreFromReplaySnapshot.mock.invocationCallOrder[0];
    const rollbackInitOrder =
      geminiClient.initialize.mock.invocationCallOrder.at(-1);
    expect(restoreOrder).toBeGreaterThan(rollbackInitOrder!);
    // UI never swapped, so core rolled back too.
    expect(startNewSession).not.toHaveBeenCalled();

    snapshotForReplay.mockRestore();
    restoreFromReplaySnapshot.mockRestore();
  });

  it('keeps the replayed usage when the resume commits', async () => {
    const snapshotForReplay = vi
      .spyOn(uiTelemetryService, 'snapshotForReplay')
      .mockReturnValue({ sessionId: 'new-session-id' } as never);
    const restoreFromReplaySnapshot = vi
      .spyOn(uiTelemetryService, 'restoreFromReplaySnapshot')
      .mockImplementation(() => {});
    const { config } = resumeConfigForTelemetry({});
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
        startNewSession: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.handleResume('new-session-id');
    });

    expect(snapshotForReplay).toHaveBeenCalledWith('new-session-id');
    expect(restoreFromReplaySnapshot).not.toHaveBeenCalled();

    snapshotForReplay.mockRestore();
    restoreFromReplaySnapshot.mockRestore();
  });

  it('replays usage again when retrying after a failed resume', async () => {
    uiTelemetryService.reset();
    try {
      let currentSessionId = 'old-session-id';
      let initializedSessionId = currentSessionId;
      uiTelemetryService.recordSkillInvocation(
        'live-old-session',
        true,
        currentSessionId,
      );
      const geminiClient = {
        initialize: vi.fn(async () => {
          if (initializedSessionId === currentSessionId) return;
          initializedSessionId = currentSessionId;
          uiTelemetryService.recordSkillInvocation(
            `replay-${currentSessionId}`,
            true,
            currentSessionId,
          );
        }),
      };
      const startCoreSession = vi.fn((sessionId: string) => {
        currentSessionId = sessionId;
      });
      const loadPausedBackgroundAgents = vi
        .fn()
        .mockRejectedValueOnce(new Error('agent sidecar unreadable'))
        .mockResolvedValue([]);
      const { config } = resumeConfigForTelemetry({
        geminiClient,
        getSessionId: () => currentSessionId,
        startNewSession: startCoreSession,
        loadPausedBackgroundAgents,
      });
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
          startNewSession: vi.fn(),
        }),
      );

      await act(async () => {
        await result.current.handleResume('new-session-id');
      });
      expect(currentSessionId).toBe('old-session-id');
      expect(uiTelemetryService.getMetrics().skills?.totalCalls).toBe(1);

      await act(async () => {
        await result.current.handleResume('new-session-id');
      });
      expect(currentSessionId).toBe('new-session-id');
      expect(uiTelemetryService.getMetrics().skills?.totalCalls).toBe(2);
      expect(geminiClient.initialize).toHaveBeenCalledTimes(3);
    } finally {
      uiTelemetryService.reset();
    }
  });

  it('does not double-count a same-session replay from desynchronized client state', async () => {
    uiTelemetryService.reset();
    try {
      const currentSessionId = 'old-session-id';
      let initializedSessionId = 'abandoned-session-id';
      uiTelemetryService.recordSkillInvocation(
        'live-old-session',
        true,
        currentSessionId,
      );
      const geminiClient = {
        initialize: vi.fn(async () => {
          if (initializedSessionId === currentSessionId) return;
          initializedSessionId = currentSessionId;
          uiTelemetryService.recordSkillInvocation(
            'replayed-old-session',
            true,
            currentSessionId,
          );
        }),
      };
      const { config } = resumeConfigForTelemetry({ geminiClient });
      const { result } = renderHook(() =>
        useResumeCommand({
          config,
          settings: mockSettings,
          historyManager: {
            addItem: vi.fn(),
            clearItems: vi.fn(),
            loadHistory: vi.fn(),
          },
          startNewSession: vi.fn(),
        }),
      );

      await act(async () => {
        await result.current.handleResume(currentSessionId);
      });

      expect(geminiClient.initialize).toHaveBeenCalledTimes(1);
      expect(uiTelemetryService.getMetrics().skills?.totalCalls).toBe(1);
      expect(
        uiTelemetryService.getMetricsForSession(currentSessionId).skills
          ?.totalCalls,
      ).toBe(1);
    } finally {
      uiTelemetryService.reset();
    }
  });

  it('undoes a replay when resuming the session already current', async () => {
    const snapshot = { sessionId: 'old-session-id' } as never;
    const snapshotForReplay = vi
      .spyOn(uiTelemetryService, 'snapshotForReplay')
      .mockReturnValue(snapshot);
    const restoreFromReplaySnapshot = vi
      .spyOn(uiTelemetryService, 'restoreFromReplaySnapshot')
      .mockImplementation(() => {});
    const { config } = resumeConfigForTelemetry({});
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
        startNewSession: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.handleResume('old-session-id');
    });

    expect(snapshotForReplay).toHaveBeenCalledWith('old-session-id');
    expect(restoreFromReplaySnapshot).toHaveBeenCalledWith(snapshot);

    snapshotForReplay.mockRestore();
    restoreFromReplaySnapshot.mockRestore();
  });
});

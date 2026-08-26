/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const { writeTerminalTitleSpy, useWakeRepaintMock, buildWakeRepaintSpy } =
  vi.hoisted(() => ({
    writeTerminalTitleSpy: vi.fn(),
    useWakeRepaintMock: vi.fn(),
    buildWakeRepaintSpy: vi.fn((deps: Record<string, unknown>) =>
      vi.fn(() => deps),
    ),
  }));

vi.mock('./hooks/use-wake-repaint.js', () => ({
  useWakeRepaint: useWakeRepaintMock,
}));

vi.mock('./utils/terminal-resize-reflow.js', () => ({
  buildWakeRepaint: buildWakeRepaintSpy,
}));

vi.mock('./utils/windowTitle.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./utils/windowTitle.js')>();
  return {
    ...actual,
    writeTerminalTitle: (
      ...args: Parameters<typeof actual.writeTerminalTitle>
    ) => {
      writeTerminalTitleSpy(...args);
      return actual.writeTerminalTitle(...args);
    },
  };
});

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { renderHook } from '@testing-library/react';
import { useContext, useState, useReducer, useEffect, act } from 'react';
import {
  AppContainer,
  dedupeNewestFirst,
  getSpeculativeToolResult,
  getNextRenderMode,
  isInputActiveForState,
  isRenderModeToggleKey,
  mergeStartupWarnings,
  shouldAutoOpenSkillReview,
  shouldDrainMessageQueue,
  useQueuedSubmissionDrain,
} from './AppContainer.js';
import {
  formatSessionWindowTitle,
  writeTerminalTitle,
} from './utils/windowTitle.js';
import ansiEscapes from 'ansi-escapes';
import {
  type Config,
  makeFakeConfig,
  SendMessageType,
  ToolNames,
  type GeminiClient,
  type GoalTurnHost,
  type SubagentManager,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { InitializationResult } from '../core/initializer.js';
import { UIStateContext, type UIState } from './contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import {
  useRenderMode,
  type RenderMode,
} from './contexts/RenderModeContext.js';
import {
  useThoughtExpanded,
  type ThoughtExpandedValue,
} from './contexts/ThoughtExpandedContext.js';
import {
  type HistoryItem,
  type HistoryItemWithoutId,
  MessageType,
  StreamingState,
  ToolCallStatus,
} from './types.js';
import { CommandKind } from './commands/types.js';
import {
  CONTEXT_FILES_ANNOUNCEMENT_PREFIX,
  isContextFilesAnnouncement,
} from './utils/commandUtils.js';
import { ICON } from './constants.js';
import type { RestoreOption } from './components/RewindSelector.js';
import { Box, measureElement } from 'ink';
import type { Content } from '@google/genai';

// Mock useStdout to capture terminal title writes
let mockStdout: { write: ReturnType<typeof vi.fn> };
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: mockStdout }),
    measureElement: vi.fn(),
  };
});

// Helper component will read the context values provided by AppContainer
// so we can assert against them in our tests.
let capturedUIState: UIState;
let capturedUIActions: UIActions;
let capturedRenderMode: RenderMode;
let capturedThoughtExpanded: ThoughtExpandedValue;
function TestContextConsumer() {
  capturedUIState = useContext(UIStateContext)!;
  capturedUIActions = useContext(UIActionsContext)!;
  capturedRenderMode = useRenderMode().renderMode;
  capturedThoughtExpanded = useThoughtExpanded();
  return <Box ref={capturedUIState.mainControlsRef} />;
}

vi.mock('./App.js', () => ({
  App: TestContextConsumer,
}));

vi.mock('./hooks/useHistoryManager.js');
vi.mock('./hooks/useThemeCommand.js');
vi.mock('./auth/useAuth.js');
vi.mock('./hooks/useEditorSettings.js');
vi.mock('./hooks/useSettingsCommand.js');
vi.mock('./hooks/useModelCommand.js');
vi.mock('./hooks/slashCommandProcessor.js');
vi.mock('./hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 80, rows: 24 })),
}));
vi.mock('./hooks/useGeminiStream.js');
vi.mock('./hooks/vim.js');
vi.mock('./hooks/useFocus.js');
vi.mock('./hooks/useBracketedPaste.js');
vi.mock('./hooks/useKeypress.js');
vi.mock('./hooks/useLoadingIndicator.js');
vi.mock('./hooks/useFolderTrust.js');
vi.mock('./hooks/useIdeTrustListener.js');
vi.mock('./hooks/useMessageQueue.js');
vi.mock('./hooks/useAutoAcceptIndicator.js');
vi.mock('./hooks/useGitBranchName.js');
vi.mock('./hooks/usePreferredEditor.js');
vi.mock('./hooks/useWorktreeSession.js');
vi.mock('./hooks/useProviderUpdates.js', () => ({
  useProviderUpdates: vi.fn(() => ({
    providerUpdateRequest: undefined,
    dismissProviderUpdate: vi.fn(),
  })),
}));
vi.mock('./contexts/VimModeContext.js');
vi.mock('./contexts/SessionContext.js');
vi.mock('./contexts/AgentViewContext.js', () => ({
  useAgentViewState: vi.fn(() => ({
    activeView: 'main',
    agents: new Map(),
  })),
  useAgentViewActions: vi.fn(() => ({
    switchToAgent: vi.fn(),
    switchToNext: vi.fn(),
    switchToPrevious: vi.fn(),
    registerAgent: vi.fn(),
    unregisterAgent: vi.fn(),
    unregisterAll: vi.fn(),
  })),
}));
vi.mock('./components/shared/text-buffer.js');
vi.mock('./hooks/useLogger.js');
vi.mock('../services/prompt-stash.js');

// Mock external utilities
vi.mock('../utils/events.js');
vi.mock('./handleAutoUpdate.js');
vi.mock('../utils/cleanup.js');

const mockLoadHierarchicalGeminiMemory = vi.hoisted(() => vi.fn());
vi.mock('../config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/config.js')>();
  return {
    ...actual,
    loadHierarchicalGeminiMemory: mockLoadHierarchicalGeminiMemory,
  };
});

import { useHistory } from './hooks/useHistoryManager.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './auth/useAuth.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useModelCommand } from './hooks/useModelCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { useVim } from './hooks/vim.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { useIdeTrustListener } from './hooks/useIdeTrustListener.js';
import { useMessageQueue } from './hooks/useMessageQueue.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useWorktreeSession } from './hooks/useWorktreeSession.js';
import {
  useVimMode,
  useVimModeActions,
  useVimModeState,
} from './contexts/VimModeContext.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useKeypress, type Key } from './hooks/useKeypress.js';
import { ShellExecutionService } from '@qwen-code/qwen-code-core';
import { clearCiEnv } from '../test-utils/ci-env.js';
import { restorePromptStash } from '../services/prompt-stash.js';

describe('AppContainer State Management', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockInitResult: InitializationResult;

  // Create typed mocks for all hooks
  const mockedUseHistory = useHistory as Mock;
  const mockedUseThemeCommand = useThemeCommand as Mock;
  const mockedUseAuthCommand = useAuthCommand as Mock;
  const mockedUseEditorSettings = useEditorSettings as Mock;
  const mockedUseSettingsCommand = useSettingsCommand as Mock;
  const mockedUseModelCommand = useModelCommand as Mock;
  const mockedUseSlashCommandProcessor = useSlashCommandProcessor as Mock;
  const mockedUseGeminiStream = useGeminiStream as Mock;
  const mockedUseVim = useVim as Mock;
  const mockedUseFolderTrust = useFolderTrust as Mock;
  const mockedUseIdeTrustListener = useIdeTrustListener as Mock;
  const mockedUseMessageQueue = useMessageQueue as Mock;
  const mockedUseAutoAcceptIndicator = useAutoAcceptIndicator as Mock;
  const mockedUseGitBranchName = useGitBranchName as Mock;
  const mockedUseWorktreeSession = useWorktreeSession as Mock;
  const mockedUseVimMode = useVimMode as Mock;
  const mockedUseVimModeActions = useVimModeActions as Mock;
  const mockedUseVimModeState = useVimModeState as Mock;
  const mockedUseSessionStats = useSessionStats as Mock;
  const mockedUseTextBuffer = useTextBuffer as Mock;
  const mockedUseLogger = useLogger as Mock;
  const mockedUseLoadingIndicator = useLoadingIndicator as Mock;
  const mockedUseTerminalSize = useTerminalSize as Mock;
  const mockedUseKeypress = useKeypress as Mock;
  let originalStdoutIsTTY: boolean | undefined;
  let restoreCiEnv = () => {};
  let mockClearPendingState: Mock;
  const mockedRestorePromptStash = vi.mocked(restorePromptStash);

  // Shared helper to extract AppContainer's global keypress handler
  // (handleGlobalKeypress) from the useKeypress mock. The handler stringifies
  // to include TOGGLE_THINKING_EXPANDED, so that token is the stable
  // discovery idiom. Used by the Ctrl+O and Cancel Handler describe blocks.
  const getGlobalKeypress = (): ((key: Key) => void) | undefined =>
    mockedUseKeypress.mock.calls
      .map((call) => call[0])
      .reverse()
      .find(
        (handler): handler is (key: Key) => void =>
          typeof handler === 'function' &&
          handler.toString().includes('TOGGLE_THINKING_EXPANDED'),
      );

  beforeEach(() => {
    vi.clearAllMocks();
    restoreCiEnv = clearCiEnv();
    vi.stubEnv('TERM', 'xterm-256color');
    originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // Initialize mock stdout for terminal title tests
    mockStdout = { write: vi.fn() };

    capturedUIState = null!;
    capturedUIActions = null!;
    capturedRenderMode = 'render';
    capturedThoughtExpanded = null!;
    mockClearPendingState = vi.fn();

    // **Provide a default return value for EVERY mocked hook.**
    mockedUseHistory.mockReturnValue({
      history: [],
      addItem: vi.fn(),
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      truncateToItem: vi.fn(),
    });
    mockedUseThemeCommand.mockReturnValue({
      isThemeDialogOpen: false,
      openThemeDialog: vi.fn(),
      handleThemeSelect: vi.fn(),
      handleThemeHighlight: vi.fn(),
    });
    mockedUseAuthCommand.mockReturnValue({
      authState: 'authenticated',
      setAuthState: vi.fn(),
      authError: null,
      onAuthError: vi.fn(),
      isAuthDialogOpen: false,
      isAuthenticating: false,
      pendingAuthType: undefined,
      externalAuthState: null,
      qwenAuthState: {
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      },
      state: {
        authError: null,
        isAuthDialogOpen: false,
        isAuthenticating: false,
        pendingAuthType: undefined,
        externalAuthState: null,
        qwenAuthState: {
          deviceAuth: null,
          authStatus: 'idle',
          authMessage: null,
        },
      },
      closeAuthDialog: vi.fn(),
      handleProviderSubmit: vi.fn(),
      openAuthDialog: vi.fn(),
      cancelAuthentication: vi.fn(),
      actions: {
        setAuthState: vi.fn(),
        onAuthError: vi.fn(),
        closeAuthDialog: vi.fn(),
        handleProviderSubmit: vi.fn(),
        openAuthDialog: vi.fn(),
        cancelAuthentication: vi.fn(),
      },
    });
    mockedUseEditorSettings.mockReturnValue({
      isEditorDialogOpen: false,
      openEditorDialog: vi.fn(),
      handleEditorSelect: vi.fn(),
      exitEditorDialog: vi.fn(),
    });
    mockedUseSettingsCommand.mockReturnValue({
      isSettingsDialogOpen: false,
      openSettingsDialog: vi.fn(),
      closeSettingsDialog: vi.fn(),
    });
    mockedUseModelCommand.mockReturnValue({
      isModelDialogOpen: false,
      openModelDialog: vi.fn(),
      closeModelDialog: vi.fn(),
    });
    mockedUseSlashCommandProcessor.mockReturnValue({
      handleSlashCommand: vi.fn(),
      slashCommands: [],
      pendingHistoryItems: [],
      commandContext: {},
      shellConfirmationRequest: null,
      confirmationRequest: null,
    });
    mockedUseGeminiStream.mockReturnValue({
      streamingState: 'idle',
      submitQuery: vi.fn(),
      initError: null,
      pendingHistoryItems: [],
      thought: null,
      cancelOngoingRequest: vi.fn(),
      retryLastPrompt: vi.fn(),
      streamingResponseLengthRef: { current: 0 },
      isReceivingContent: false,
      clearPendingState: mockClearPendingState,
    });
    mockedUseVim.mockReturnValue({ handleInput: vi.fn() });
    mockedUseFolderTrust.mockReturnValue({
      isFolderTrustDialogOpen: false,
      handleFolderTrustSelect: vi.fn(),
      isRestarting: false,
    });
    mockedUseIdeTrustListener.mockReturnValue({
      needsRestart: false,
      restartReason: 'NONE',
    });
    mockedUseMessageQueue.mockReturnValue({
      removeGoalTurns: vi.fn().mockReturnValue([]),
      messageQueue: [],
      addMessage: vi.fn(),
      clearQueue: vi.fn(),
      getQueuedMessagesText: vi.fn().mockReturnValue(''),
      popAllMessages: vi.fn().mockReturnValue(null),
      drainQueue: vi.fn().mockReturnValue([]),
      popNextTurn: vi.fn().mockReturnValue(null),
    });
    mockedUseAutoAcceptIndicator.mockReturnValue(false);
    mockedUseGitBranchName.mockReturnValue('main');
    mockedUseVimMode.mockReturnValue({
      isVimEnabled: false,
      toggleVimEnabled: vi.fn(),
    });
    mockedUseVimModeActions.mockReturnValue({
      toggleVimEnabled: vi.fn(),
      setVimMode: vi.fn(),
    });
    mockedUseVimModeState.mockReturnValue({
      vimEnabled: false,
      vimMode: 'NORMAL',
    });
    mockedUseSessionStats.mockReturnValue({
      stats: {},
      seedPromptCount: vi.fn(),
    });
    mockedUseTextBuffer.mockReturnValue({
      text: '',
      setText: vi.fn(),
      // Add other properties if AppContainer uses them
    });
    mockedUseLogger.mockReturnValue({
      getPreviousUserMessages: vi.fn().mockResolvedValue([]),
      removeLastUserMessage: vi.fn().mockResolvedValue(false),
    });
    mockedRestorePromptStash.mockReturnValue(false);
    mockedUseLoadingIndicator.mockReturnValue({
      elapsedTime: '0.0s',
      currentLoadingPhrase: '',
      taskStartTokens: 0,
      taskStartStreamingChars: 0,
    });
    mockedUseTerminalSize.mockReturnValue({ columns: 80, rows: 24 });

    // Mock Config
    mockConfig = makeFakeConfig();

    // Mock config's getTargetDir to return consistent workspace directory
    vi.spyOn(mockConfig, 'getTargetDir').mockReturnValue('/test/workspace');

    // Mock GeminiClient to prevent unhandled errors from AgentTool.refreshSubagents
    const mockGeminiClient: Partial<GeminiClient> = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setTools: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(false), // Return false to prevent setTools from being called
    };
    vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue(
      mockGeminiClient as GeminiClient,
    );

    // Mock SubagentManager to prevent errors during AgentTool initialization.
    // getAvailableModelGrades must be present: the mount effect runs the real
    // config.initialize() in an un-awaited IIFE, which constructs AgentTool
    // against this mock, and refreshSubagents reads the grades there.
    const mockSubagentManager: Partial<SubagentManager> = {
      listSubagents: vi.fn().mockResolvedValue([]),
      addChangeListener: vi.fn(),
      loadSubagent: vi.fn(),
      createSubagent: vi.fn(),
      getAvailableModelGrades: vi.fn().mockReturnValue(new Map()),
    };
    vi.spyOn(mockConfig, 'getSubagentManager').mockReturnValue(
      mockSubagentManager as SubagentManager,
    );

    // Mock LoadedSettings
    mockSettings = {
      merged: {
        hideTips: false,
        theme: 'default',
        ui: {
          showStatusInTitle: false,
          hideWindowTitle: false,
          useTerminalBuffer: false,
        },
      },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    // Mock InitializationResult
    mockInitResult = {
      themeError: null,
      authError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    } as InitializationResult;
  });

  it('gives the Agent tool the full SubagentManager surface during initialization', async () => {
    // AppContainer's mount effect runs config.initialize() in an un-awaited
    // IIFE; the real initialize warms the tool registry, constructing
    // AgentTool against this mock. A SubagentManager mock missing a method
    // AgentTool reads rejects refreshSubagents there and surfaces as an
    // unhandled rejection that fails the whole run, so pin the surface here,
    // where a missing method fails this test instead of leaking.
    await mockConfig.initialize();
    const agentTool = mockConfig
      .getToolRegistry()
      ?.getTool(ToolNames.AGENT) as unknown as
      | { refreshSubagents: () => Promise<void> }
      | undefined;
    expect(agentTool).toBeDefined();
    await expect(agentTool!.refreshSubagents()).resolves.toBeUndefined();
  });

  describe('speculative tool results', () => {
    it('renders error envelopes as failed tools', () => {
      expect(
        getSpeculativeToolResult({
          error: 'Command timed out.\npartial output',
        }),
      ).toEqual({
        text: 'Command timed out.\npartial output',
        status: ToolCallStatus.Error,
      });
    });

    it('keeps output envelopes successful', () => {
      expect(getSpeculativeToolResult({ output: 'done' })).toEqual({
        text: 'done',
        status: ToolCallStatus.Success,
      });
    });
  });

  afterEach(() => {
    if (originalStdoutIsTTY === undefined) {
      delete (process.stdout as { isTTY?: unknown }).isTTY;
    } else {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutIsTTY,
        configurable: true,
      });
    }
    vi.unstubAllEnvs();
    restoreCiEnv();
    cleanup();
    vi.useRealTimers();
  });

  const rewindUserItem = (
    id: number,
    text: string,
    promptId?: string,
  ): HistoryItem => ({
    id,
    type: 'user',
    text,
    promptId,
  });

  const apiUser = (text: string): Content => ({
    role: 'user',
    parts: [{ text }],
  });

  const apiModel = (text: string): Content => ({
    role: 'model',
    parts: [{ text }],
  });

  type RewindHarnessOptions = {
    apiHistory?: Content[];
    fileRewindResult?: {
      filesChanged: string[];
      filesFailed: string[];
    };
    fileRewindError?: Error;
    noGeminiClient?: boolean;
    history?: HistoryItem[];
    contextFilePaths?: string[];
  };

  const renderRewindHarness = (options: RewindHarnessOptions = {}) => {
    const history: HistoryItem[] = options.history ?? [
      rewindUserItem(1, 'first prompt', 'prompt-1'),
      { id: 2, type: 'gemini', text: 'first response' },
      rewindUserItem(3, 'second prompt', 'prompt-2'),
      { id: 4, type: 'gemini', text: 'second response' },
    ];
    const target = history[2]!;
    const addItem = vi.fn();
    const loadHistory = vi.fn();
    const truncateToItem = vi.fn();
    mockedUseHistory.mockReturnValue({
      history,
      addItem,
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory,
      truncateToItem,
    });

    const setText = vi.fn();
    mockedUseTextBuffer.mockReturnValue({
      text: '',
      setText,
    });
    const addMessage = vi.fn();
    mockedUseMessageQueue.mockReturnValue({
      removeGoalTurns: vi.fn().mockReturnValue([]),
      messageQueue: [],
      addMessage,
      clearQueue: vi.fn(),
      getQueuedMessagesText: vi.fn().mockReturnValue(''),
      popAllMessages: vi.fn().mockReturnValue(null),
      drainQueue: vi.fn().mockReturnValue([]),
      popNextTurn: vi.fn().mockReturnValue(null),
    });

    const apiHistory = options.apiHistory ?? [
      apiUser('first prompt'),
      apiModel('first response'),
      apiUser('second prompt'),
      apiModel('second response'),
    ];
    const getHistoryShallow = vi.fn(() => apiHistory);
    const truncateHistory = vi.fn();
    const geminiClient = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setTools: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(false),
      getHistoryShallow,
      truncateHistory,
    } as unknown as GeminiClient;
    vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue(
      options.noGeminiClient ? (null as unknown as GeminiClient) : geminiClient,
    );

    const rewind = vi.fn();
    if (options.fileRewindError) {
      rewind.mockRejectedValue(options.fileRewindError);
    } else {
      rewind.mockResolvedValue(
        options.fileRewindResult ?? {
          filesChanged: ['src/foo.ts'],
          filesFailed: [],
        },
      );
    }
    const snapshots = [
      { promptId: 'prompt-1' },
      { promptId: 'prompt-2' },
      { promptId: 'prompt-3' },
    ];
    const getSnapshots = vi.fn(() => snapshots);
    vi.spyOn(mockConfig, 'getFileHistoryService').mockReturnValue({
      rewind,
      getSnapshots,
    } as unknown as ReturnType<Config['getFileHistoryService']>);

    const rewindRecording = vi.fn();
    vi.spyOn(mockConfig, 'getChatRecordingService').mockReturnValue({
      rewindRecording,
    } as unknown as NonNullable<ReturnType<Config['getChatRecordingService']>>);

    if (options.contextFilePaths) {
      vi.spyOn(mockConfig, 'getContextFilePaths').mockReturnValue(
        options.contextFilePaths,
      );
    }

    render(
      <AppContainer
        config={mockConfig}
        settings={mockSettings}
        version="1.0.0"
        initializationResult={mockInitResult}
      />,
    );

    return {
      target,
      addItem,
      loadHistory,
      setText,
      addMessage,
      rewind,
      getHistoryShallow,
      truncateHistory,
      rewindRecording,
      snapshots,
    };
  };

  const runRewind = async (userItem: HistoryItem, option: RestoreOption) => {
    await act(async () => {
      await (capturedUIActions.handleRewindConfirm(
        userItem,
        option,
      ) as unknown as Promise<void>);
    });
  };

  describe('worktree branch wiring', () => {
    it('queries the branch from the worktree path during a worktree session', () => {
      mockedUseWorktreeSession.mockReturnValue({
        slug: 'feature',
        worktreePath: '/repo/.qwen/worktrees/feature',
        worktreeBranch: 'worktree-feature',
        originalCwd: '/repo',
        originalBranch: 'main',
        originalHeadCommit: 'abc123',
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockedUseGitBranchName).toHaveBeenCalledWith(
        '/repo/.qwen/worktrees/feature',
      );
    });

    it('falls back to the workspace target dir without a worktree session', () => {
      mockedUseWorktreeSession.mockReturnValue(null);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockedUseGitBranchName).toHaveBeenCalledWith('/test/workspace');
    });
  });

  describe('Basic Rendering', () => {
    it('continues quitting when cancelling the active request fails', () => {
      vi.useFakeTimers();
      const cancelOngoingRequest = vi.fn(() => {
        throw new Error('cancel failed');
      });
      const requestShutdown = vi.fn();
      mockedUseGeminiStream.mockReturnValue({
        streamingState: StreamingState.Responding,
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest,
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        setTools: vi.fn().mockResolvedValue(undefined),
        isInitialized: vi.fn().mockReturnValue(false),
        requestShutdown,
      } as unknown as GeminiClient);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      const slashCommandActions = mockedUseSlashCommandProcessor.mock.calls.at(
        -1,
      )?.[12] as { quit: (messages: HistoryItem[]) => void };
      const timerCount = vi.getTimerCount();
      expect(() => slashCommandActions.quit([])).not.toThrow();

      expect(cancelOngoingRequest).toHaveBeenCalledOnce();
      expect(requestShutdown).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(timerCount + 1);
    });

    it('shows recording failures as warnings and unsubscribes on unmount', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: vi.fn(),
      });
      let listener:
        | ((event: { sessionId: string; error: Error }) => void)
        | undefined;
      const unsubscribe = vi.fn();
      vi.spyOn(mockConfig, 'onChatRecordingFailure').mockImplementation(
        (nextListener) => {
          listener = nextListener;
          return unsubscribe;
        },
      );

      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await act(async () => {
        listener?.({ sessionId: 's-1', error: new Error('EACCES') });
      });

      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.WARNING,
          text: expect.stringContaining('Session recording stopped'),
        }),
        expect.any(Number),
      );
      unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('renders without crashing with minimal props', () => {
      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('renders with startup warnings', () => {
      const startupWarnings = ['Warning 1', 'Warning 2'];

      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            startupWarnings={startupWarnings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('State Initialization', () => {
    it('initializes with theme error from initialization result', () => {
      const initResultWithError = {
        ...mockInitResult,
        themeError: 'Failed to load theme',
      };

      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={initResultWithError}
          />,
        );
      }).not.toThrow();
    });

    it('handles debug mode state', () => {
      const debugConfig = makeFakeConfig();
      vi.spyOn(debugConfig, 'getDebugMode').mockReturnValue(true);

      expect(() => {
        render(
          <AppContainer
            config={debugConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('Context Providers', () => {
    const renderRespondingInput = (
      slashCommands: Array<{
        name: string;
        description: string;
        kind: 'built-in';
        canRunDuringStreaming?: boolean;
      }>,
    ) => {
      const handleSlashCommand = vi.fn();
      const submitQuery = vi.fn();
      const addMessage = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand,
        slashCommands,
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [],
        addMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });
      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      return { handleSlashCommand, submitQuery, addMessage };
    };

    it('provides AppContext with correct values', () => {
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="2.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Should render and unmount cleanly
      expect(() => unmount()).not.toThrow();
    });

    it('dedupes startup warnings produced during config initialization', () => {
      expect(
        mergeStartupWarnings(
          ['early warning', 'same warning'],
          ['same warning', 'late memory warning'],
        ),
      ).toEqual(['early warning', 'same warning', 'late memory warning']);
    });

    it('provides UIStateContext with state management', () => {
      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('provides UIActionsContext with action handlers', () => {
      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('refreshStatic clears the terminal before remounting history', () => {
      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.refreshStatic();

      expect(mockStdout.write).toHaveBeenCalledWith(ansiEscapes.clearTerminal);
    });

    it('refreshStatic stays write-free in VP mode for ordinary callers (#8557)', () => {
      const vpSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: true,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={vpSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      mockStdout.write.mockClear();

      capturedUIActions.refreshStatic();

      // Ordinary callers (/clear, model change, Ctrl+O, ...) must not
      // trigger a physical clear-and-replay in VP: replaying the pre-change
      // frame would flash stale content. Their refresh comes from the state
      // change that triggered them; only the wake path repaints physically.
      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearViewport,
      );
      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
    });

    // The wake/SIGCONT trigger itself is covered by use-wake-repaint.test.ts
    // (SIGCONT/heartbeat-gap -> repaint callback); the VP/static selection is
    // unit-covered by buildWakeRepaint tests. This test locks the AppContainer
    // call site: the callback handed to the hook must be the wake repaint
    // (repaintViewport + remount), not refreshStatic or a mis-wired memo.
    it('wires the wake repaint (not refreshStatic) into useWakeRepaint', async () => {
      useWakeRepaintMock.mockClear();
      buildWakeRepaintSpy.mockClear();
      const repaintSpy = vi.fn();
      const vpSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: true,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={vpSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
          repaintViewport={repaintSpy}
        />,
      );

      // Let ink-testing-library's scheduled initial render flush.
      await Promise.resolve();
      // The call site must build the wake callback via buildWakeRepaint with
      // the repaint prop AND the static remount bump in its deps; inline
      // repaint-only wrappers (the shape that drops the agent-tab <Static>
      // re-emit) fail these.
      const deps = buildWakeRepaintSpy.mock.calls.at(-1)?.[0];
      expect(deps?.['isVP']).toBe(true);
      expect(deps?.['repaintViewport']).toBe(repaintSpy);
      expect(typeof deps?.['remountStaticHistory']).toBe('function');
      const wakeCallback = useWakeRepaintMock.mock.calls.at(-1)?.[0];
      expect(wakeCallback).toBe(buildWakeRepaintSpy.mock.results.at(-1)?.value);
    });

    it('defaults to VP mode when useTerminalBuffer is unset', () => {
      const defaultSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={defaultSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIState.useTerminalBuffer).toBe(true);
    });

    it('keeps non-TTY output on the Static path', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      const defaultSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={defaultSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIState.useTerminalBuffer).toBe(false);
    });

    it('uses the startup VP decision when provided', () => {
      const legacySettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: false,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={legacySettings}
          version="1.0.0"
          initializationResult={mockInitResult}
          initialUseVirtualViewport={true}
        />,
      );

      expect(capturedUIState.useTerminalBuffer).toBe(true);
    });

    it('uses a disabled startup VP decision over an enabled setting', () => {
      const vpSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: true,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={vpSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
          initialUseVirtualViewport={false}
        />,
      );

      expect(capturedUIState.useTerminalBuffer).toBe(false);
    });

    it('keeps screen reader mode on the Static path when useTerminalBuffer is unset', () => {
      vi.spyOn(mockConfig, 'getScreenReader').mockReturnValue(true);
      const defaultSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={defaultSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIState.useTerminalBuffer).toBe(false);
    });

    it('locks terminal buffer mode for the running session', () => {
      const vpSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: true,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;
      const legacySettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: false,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
      let updateSettings!: (settings: LoadedSettings) => void;
      function Wrapper() {
        const [settings, setSettings] = useState(vpSettings);
        updateSettings = setSettings;
        return (
          <AppContainer
            config={mockConfig}
            settings={settings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />
        );
      }

      render(<Wrapper />);

      expect(capturedUIState.useTerminalBuffer).toBe(true);

      act(() => updateSettings(legacySettings));

      expect(capturedUIState.useTerminalBuffer).toBe(true);
    });

    // Resize no longer triggers a clearTerminal or history remount (#8004).
    // The old settle → refreshStatic path caused a scroll storm; the dynamic
    // region now re-renders via useTerminalSize alone. This test pins that
    // no synchronous clear fires during a width change.
    it('does not clear the terminal synchronously on width change', () => {
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
      mockedUseTerminalSize.mockReturnValue({ columns: 80, rows: 24 });
      const { rerender } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      mockStdout.write.mockClear();

      mockedUseTerminalSize.mockReturnValue({ columns: 100, rows: 24 });
      rerender(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
    });

    it('does not repaint static history after a resize settles (#8004)', () => {
      vi.useFakeTimers();
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
      // measureElement must return a real measurement; a bare vi.fn() returns
      // undefined, the controlsHeight layout effect throws on .height, and
      // ink's ErrorBoundary silently unmounts the tree — making every
      // post-mount assertion vacuous.
      (measureElement as Mock).mockReturnValue({ width: 80, height: 2 });

      // Deliver width changes to the SAME mounted instance. rerender() from
      // ink-testing-library remounts the tree (ErrorBoundary issue above),
      // re-seeding useRef(terminalWidth) so a settle debounce never fires.
      let columns = 80;
      const resizeListeners = new Set<() => void>();
      mockedUseTerminalSize.mockImplementation(() => {
        const [, force] = useReducer((x: number) => x + 1, 0);
        useEffect(() => {
          resizeListeners.add(force);
          return () => {
            resizeListeners.delete(force);
          };
        }, []);
        return { columns, rows: 24 };
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Liveness control: fails if the ErrorBoundary unmounted the tree.
      expect(resizeListeners.size).toBeGreaterThan(0);
      const remountKeyBefore = capturedUIState.historyRemountKey;
      mockStdout.write.mockClear();

      act(() => {
        columns = 100;
        for (const notify of resizeListeners) notify();
      });

      // Advance well past the old RESIZE_REPAINT_SETTLE_MS (200ms) debounce.
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      expect(capturedUIState.historyRemountKey).toBe(remountKeyBefore);

      vi.useRealTimers();
      (measureElement as Mock).mockReturnValue(undefined);
    });

    it('handleClearScreen avoids a second clearTerminal write', () => {
      const clearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {});

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleClearScreen();

      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(mockClearPendingState).toHaveBeenCalledTimes(1);
      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );

      clearSpy.mockRestore();
    });

    it('passes a remount-only refresh callback to slash commands', () => {
      let slashRefreshStatic: (() => void) | undefined;
      mockedUseSlashCommandProcessor.mockImplementation(
        (
          _config,
          _settings,
          _history,
          _addItem,
          _clearItems,
          _loadHistory,
          refreshStatic,
        ) => {
          slashRefreshStatic = refreshStatic;
          return {
            handleSlashCommand: vi.fn(),
            slashCommands: [],
            pendingHistoryItems: [],
            commandContext: {},
            shellConfirmationRequest: null,
            confirmationRequest: null,
          };
        },
      );

      // remount-only behavior holds in VP mode, where refreshStatic must
      // not clear the terminal.
      const vpSettings = {
        merged: {
          hideTips: false,
          theme: 'default',
          ui: {
            showStatusInTitle: false,
            hideWindowTitle: false,
            useTerminalBuffer: true,
          },
        },
        setValue: vi.fn(),
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={vpSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      slashRefreshStatic?.();

      expect(slashRefreshStatic).toBeDefined();
      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
    });

    it('provides ConfigContext with config object', () => {
      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('keeps input active while compression is processing', () => {
      expect(
        isInputActiveForState({
          initError: null,
          isProcessing: true,
          hasPendingCompression: true,
          streamingState: StreamingState.Idle,
        }),
      ).toBe(true);

      expect(
        isInputActiveForState({
          initError: null,
          isProcessing: true,
          hasPendingCompression: false,
          streamingState: StreamingState.Idle,
        }),
      ).toBe(false);
    });

    it('does not drain queued messages while compression is processing', () => {
      expect(
        shouldDrainMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Idle,
          isProcessing: true,
          dialogsVisible: false,
          messageQueueLength: 1,
        }),
      ).toBe(false);

      expect(
        shouldDrainMessageQueue({
          isConfigInitialized: true,
          streamingState: StreamingState.Idle,
          isProcessing: false,
          dialogsVisible: false,
          messageQueueLength: 1,
        }),
      ).toBe(true);
    });

    it('binds one Goal host that enqueues, preempts, and cleans up', async () => {
      const enqueueGoalTurn = vi.fn();
      const removeGoalTurns = vi.fn().mockReturnValue([]);
      const preemptGoalTurn = vi.fn();
      const submitQuery = vi.fn();
      const unbind = vi.fn();
      let host: GoalTurnHost | undefined;
      vi.spyOn(mockConfig, 'bindGoalTurnHost').mockImplementation(
        (nextHost) => {
          host = nextHost;
          return unbind;
        },
      );
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [],
        pendingSubmissionCount: 0,
        addMessage: vi.fn(),
        enqueueGoalTurn,
        peekNextUserBatchKey: vi.fn(),
        hasQueuedUserMessages: vi.fn().mockReturnValue(false),
        getPendingSubmissionCount: vi.fn().mockReturnValue(0),
        claimGoalTurn: vi.fn(),
        claimDirectUserAdmission: vi.fn(),
        removeGoalTurns,
        popNextSubmission: vi.fn().mockReturnValue(null),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        restoreMessages: vi.fn(),
        drainQueue: vi.fn().mockReturnValue([]),
      });
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        preemptGoalTurn,
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      const view = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockConfig.bindGoalTurnHost).toHaveBeenCalledTimes(1);
      await act(async () => {
        await host!.startGoalTurn({
          permit: { goalId: 'goal-1', revision: 2, turnId: 'turn-1' },
          continuationContext: 'continue automatically',
          verifierFeedback: 'collect evidence',
        });
      });
      expect(enqueueGoalTurn).toHaveBeenCalledWith({
        permit: { goalId: 'goal-1', revision: 2, turnId: 'turn-1' },
        continuationContext: 'continue automatically',
        verifierFeedback: 'collect evidence',
      });
      expect(submitQuery).not.toHaveBeenCalled();

      act(() => {
        host!.preemptGoalTurn('goal edited');
      });
      expect(removeGoalTurns).toHaveBeenCalledTimes(1);
      expect(preemptGoalTurn).toHaveBeenCalledWith('goal edited');

      view.unmount();
      expect(unbind).toHaveBeenCalledTimes(1);
    });

    it('holds ordinary input while the Goal is active and drains it once paused', async () => {
      let goalStatus: 'active' | 'paused' = 'active';
      let goalListener: (() => void) | undefined;
      const unsubscribe = vi.fn();
      const goalRuntime = {
        getSnapshot: vi.fn(() => ({
          goal: { status: goalStatus },
        })),
        subscribe: vi.fn((listener: () => void) => {
          goalListener = listener;
          return unsubscribe;
        }),
      } as unknown as ReturnType<Config['getGoalRuntime']>;
      vi.spyOn(mockConfig, 'getGoalRuntime').mockReturnValue(goalRuntime);

      const submitQuery = vi.fn().mockResolvedValue(undefined);
      let userPopped = false;
      const popNextSubmission = vi.fn((mode = 'normal') => {
        // 'priority' (active Goal) holds the plain user batch; 'normal'
        // (paused) drains it.
        if (mode !== 'normal' || userPopped) return null;
        userPopped = true;
        return {
          kind: 'user' as const,
          modelText: 'held user work',
          turnKey: 'message-queue:held-user',
        };
      });
      const view = renderHook(() =>
        useQueuedSubmissionDrain({
          config: mockConfig,
          isConfigInitialized: true,
          streamingState: StreamingState.Idle,
          isProcessing: false,
          dialogsVisible: false,
          pendingSubmissionCount: 1,
          getPendingSubmissionCount: () => (userPopped ? 0 : 1),
          popNextSubmission,
          enqueueGoalTurn: vi.fn(),
          restoreMessages: vi.fn(),
          submitQuery,
          submissionInFlightRef: { current: false },
          submissionSettledRevision: 0,
        }),
      );

      // While the Goal is active the drain selects 'priority' and the plain
      // user batch stays held (criterion #2).
      await vi.waitFor(() => {
        expect(popNextSubmission).toHaveBeenCalledWith('priority');
      });
      expect(submitQuery).not.toHaveBeenCalled();

      // Pausing the Goal releases the held input: the drain switches to
      // 'normal' and the user work is delivered.
      goalStatus = 'paused';
      act(() => {
        goalListener?.();
      });

      await vi.waitFor(() => {
        expect(popNextSubmission).toHaveBeenCalledWith('normal');
        expect(submitQuery).toHaveBeenCalledWith(
          'held user work',
          SendMessageType.UserQuery,
          undefined,
          expect.objectContaining({
            userAdmission: { turnKey: 'message-queue:held-user' },
          }),
        );
      });
      view.unmount();
      expect(unsubscribe).toHaveBeenCalledOnce();
    });

    it('treats paused, blocked and usage_limited Goals as drain-eligible', async () => {
      const getGoalRuntimeSpy = vi.spyOn(mockConfig, 'getGoalRuntime');
      for (const status of ['paused', 'blocked', 'usage_limited'] as const) {
        getGoalRuntimeSpy.mockReturnValue({
          getSnapshot: () => ({ goal: { status } }),
          subscribe: () => vi.fn(),
        } as unknown as ReturnType<Config['getGoalRuntime']>);

        const submitQuery = vi.fn().mockResolvedValue(undefined);
        let popped = false;
        const popNextSubmission = vi.fn(() => {
          if (popped) return null;
          popped = true;
          return {
            kind: 'user' as const,
            modelText: 'ordinary user work',
            turnKey: `message-queue:${status}`,
          };
        });

        const view = renderHook(() =>
          useQueuedSubmissionDrain({
            config: mockConfig,
            isConfigInitialized: true,
            streamingState: StreamingState.Idle,
            isProcessing: false,
            dialogsVisible: false,
            pendingSubmissionCount: 1,
            getPendingSubmissionCount: () => (popped ? 0 : 1),
            popNextSubmission,
            enqueueGoalTurn: vi.fn(),
            restoreMessages: vi.fn(),
            submitQuery,
            submissionInFlightRef: { current: false },
            submissionSettledRevision: 0,
          }),
        );

        // No turn is running in these states, so the queue drains in 'normal'
        // mode and the ordinary message is delivered instead of being held.
        await vi.waitFor(() => {
          expect(popNextSubmission).toHaveBeenCalledWith('normal');
          expect(submitQuery).toHaveBeenCalledWith(
            'ordinary user work',
            SendMessageType.UserQuery,
            undefined,
            expect.objectContaining({
              userAdmission: { turnKey: `message-queue:${status}` },
            }),
          );
        });
        view.unmount();
      }
    });

    it('does not hot-loop a queued submission whose admission keeps failing', async () => {
      const goalRuntime = {
        getSnapshot: () => ({ goal: { status: 'active' } }),
        subscribe: () => vi.fn(),
      } as unknown as ReturnType<Config['getGoalRuntime']>;
      vi.spyOn(mockConfig, 'getGoalRuntime').mockReturnValue(goalRuntime);
      let synchronousPendingCount = 3;
      const popNextSubmission = vi.fn(() => {
        synchronousPendingCount = 0;
        return {
          kind: 'user' as const,
          modelText: 'persistent failure batch',
          turnKey: 'message-queue:persistent',
        };
      });
      const restoreMessages = vi.fn(() => {
        synchronousPendingCount = 1;
      });
      const submitQuery = vi.fn(async (...args: unknown[]) => {
        const metadata = args[3] as
          | { onAdmissionFailed?: () => void }
          | undefined;
        metadata?.onAdmissionFailed?.();
        throw new Error('persistent prepare failure');
      }) as unknown as ReturnType<typeof useGeminiStream>['submitQuery'];
      const { rerender } = renderHook(
        ({ pendingSubmissionCount, submissionSettledRevision }) =>
          useQueuedSubmissionDrain({
            config: mockConfig,
            isConfigInitialized: true,
            streamingState: StreamingState.Idle,
            isProcessing: false,
            dialogsVisible: false,
            pendingSubmissionCount,
            getPendingSubmissionCount: () => synchronousPendingCount,
            popNextSubmission,
            enqueueGoalTurn: vi.fn(),
            restoreMessages,
            submitQuery,
            submissionInFlightRef: { current: false },
            submissionSettledRevision,
          }),
        {
          initialProps: {
            pendingSubmissionCount: 3,
            submissionSettledRevision: 0,
          },
        },
      );

      await vi.waitFor(() => expect(submitQuery).toHaveBeenCalledOnce());
      expect(restoreMessages).toHaveBeenCalledOnce();

      rerender({
        pendingSubmissionCount: 1,
        submissionSettledRevision: 1,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(submitQuery).toHaveBeenCalledOnce();

      synchronousPendingCount = 2;
      rerender({
        pendingSubmissionCount: 2,
        submissionSettledRevision: 1,
      });
      await vi.waitFor(() => expect(submitQuery).toHaveBeenCalledTimes(2));
    });

    it('drains after preprocessing settlement releases the shared lock', async () => {
      const goalRuntime = {
        getSnapshot: () => ({ goal: { status: 'active' } }),
        subscribe: () => vi.fn(),
      } as unknown as ReturnType<Config['getGoalRuntime']>;
      vi.spyOn(mockConfig, 'getGoalRuntime').mockReturnValue(goalRuntime);
      let popped = false;
      const popNextSubmission = vi.fn(() => {
        if (popped) return null;
        popped = true;
        return {
          kind: 'user' as const,
          modelText: 'queued during preprocessing',
          turnKey: 'message-queue:during-preprocessing',
        };
      });
      const submitQuery = vi.fn().mockResolvedValue(undefined);
      const submissionInFlightRef = { current: true };
      const { rerender } = renderHook(
        ({ submissionSettledRevision }) =>
          useQueuedSubmissionDrain({
            config: mockConfig,
            isConfigInitialized: true,
            streamingState: StreamingState.Idle,
            isProcessing: false,
            dialogsVisible: false,
            pendingSubmissionCount: 1,
            getPendingSubmissionCount: () => (popped ? 0 : 1),
            popNextSubmission,
            enqueueGoalTurn: vi.fn(),
            restoreMessages: vi.fn(),
            submitQuery,
            submissionInFlightRef,
            submissionSettledRevision,
          }),
        { initialProps: { submissionSettledRevision: 0 } },
      );

      expect(popNextSubmission).not.toHaveBeenCalled();
      submissionInFlightRef.current = false;
      rerender({ submissionSettledRevision: 1 });

      await vi.waitFor(() => {
        expect(submitQuery).toHaveBeenCalledWith(
          'queued during preprocessing',
          SendMessageType.UserQuery,
          undefined,
          expect.objectContaining({
            userAdmission: {
              turnKey: 'message-queue:during-preprocessing',
            },
          }),
        );
      });
    });

    it('marks Ctrl+Q submissions to wait for the idle boundary', () => {
      const mockQueueMessage = vi.fn();
      const mockSubmitQuery = vi.fn();

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: mockSubmitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('/btw next turn', {
        deferUntilIdle: true,
        submittedPrompt: '/btw next turn',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        '/btw next turn',
        true,
        '/btw next turn',
      );
      expect(mockSubmitQuery).not.toHaveBeenCalled();
    });

    it('submits /btw immediately instead of queueing while responding', () => {
      const mockSubmitQuery = vi.fn();
      const mockQueueMessage = vi.fn();

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: mockSubmitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('/btw quick side question', {
        submittedPrompt: '/btw quick side question',
      });

      expect(mockSubmitQuery).toHaveBeenCalledWith(
        '/btw quick side question',
        SendMessageType.UserQuery,
        undefined,
        expect.objectContaining({
          submittedPrompt: '/btw quick side question',
          onAdmissionFailed: expect.any(Function),
        }),
      );
      expect(mockQueueMessage).not.toHaveBeenCalled();
    });

    it('queues a responding ?btw submission when concurrent admission fails', () => {
      const mockSubmitQuery = vi.fn();
      const mockQueueMessage = vi.fn();

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: mockSubmitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('?btw wait for the tool', {
        submittedPrompt: '?btw wait for the tool',
      });
      const metadata = mockSubmitQuery.mock.calls[0]?.[3] as
        | { onAdmissionFailed?: () => void }
        | undefined;
      metadata?.onAdmissionFailed?.();

      expect(mockQueueMessage).toHaveBeenCalledWith(
        '?btw wait for the tool',
        true,
        '?btw wait for the tool',
      );
    });

    it('runs opted-in slash commands outside the active turn while responding', () => {
      const { handleSlashCommand, submitQuery, addMessage } =
        renderRespondingInput([
          {
            name: 'settings',
            description: 'Open settings',
            kind: 'built-in',
            canRunDuringStreaming: true,
          },
        ]);

      capturedUIActions.handleFinalSubmit('/settings', {
        submittedPrompt: '/settings',
      });

      expect(handleSlashCommand).toHaveBeenCalledWith('/settings');
      expect(submitQuery).not.toHaveBeenCalled();
      expect(addMessage).not.toHaveBeenCalled();
    });

    it('keeps opted-in slash commands queued when Ctrl+Q defers them', () => {
      const { handleSlashCommand, submitQuery, addMessage } =
        renderRespondingInput([
          {
            name: 'settings',
            description: 'Open settings',
            kind: 'built-in',
            canRunDuringStreaming: true,
          },
        ]);

      capturedUIActions.handleFinalSubmit('/settings', {
        deferUntilIdle: true,
        submittedPrompt: '/settings',
      });

      expect(addMessage).toHaveBeenCalledWith('/settings', true, '/settings');
      expect(handleSlashCommand).not.toHaveBeenCalled();
      expect(submitQuery).not.toHaveBeenCalled();
    });

    it('keeps turn-dependent slash commands queued while responding', () => {
      const { handleSlashCommand, submitQuery, addMessage } =
        renderRespondingInput([
          {
            name: 'model',
            description: 'Change model',
            kind: 'built-in',
          },
        ]);

      capturedUIActions.handleFinalSubmit('/model', {
        submittedPrompt: '/model',
      });

      expect(addMessage).toHaveBeenCalledWith('/model', false, '/model');
      expect(handleSlashCommand).not.toHaveBeenCalled();
      expect(submitQuery).not.toHaveBeenCalled();
    });

    it('submits slash commands immediately instead of queueing while idle', () => {
      const mockSubmitQuery = vi.fn();
      const mockQueueMessage = vi.fn();

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: mockSubmitQuery,
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('/model', {
        submittedPrompt: '/model',
      });

      expect(mockSubmitQuery).toHaveBeenCalledWith(
        '/model',
        SendMessageType.UserQuery,
        undefined,
        { submittedPrompt: '/model' },
      );
      expect(mockQueueMessage).not.toHaveBeenCalled();
    });

    it('injects a recovered-agent reminder into the next ordinary prompt once', () => {
      const mockQueueMessage = vi.fn();
      vi.spyOn(mockConfig, 'consumePendingRecoveredAgentsNotice')
        .mockReturnValueOnce('Use list_agents to inspect restored agents.')
        .mockReturnValue(null);
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('continue the review', {
        submittedPrompt: 'continue the review',
      });
      capturedUIActions.handleFinalSubmit('one more check', {
        submittedPrompt: 'one more check',
      });

      expect(mockQueueMessage).toHaveBeenNthCalledWith(
        1,
        '<system-reminder>\nUse list_agents to inspect restored agents.\n' +
          '</system-reminder>\n\ncontinue the review',
        false,
        'continue the review',
      );
      expect(mockQueueMessage).toHaveBeenNthCalledWith(
        2,
        'one more check',
        false,
        'one more check',
      );
    });

    it('preserves unchanged queue provenance across the input clear before submit', () => {
      const modelText =
        '<system-reminder>\nmanaged context\n</system-reminder>\n\nreview this';
      const mockQueueMessage = vi.fn();
      let onBufferChange: ((text: string) => void) | undefined;
      mockedUseTextBuffer.mockImplementation((options) => {
        onBufferChange = options.onChange;
        return {
          text: '',
          setText: vi.fn(),
        };
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [modelText],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(modelText),
        removeGoalTurns: vi.fn().mockReturnValue([]),
        popAllMessages: vi.fn().mockReturnValue({
          modelText,
          submittedPrompt: 'review this',
        }),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      capturedUIActions.handleFinalSubmit(modelText, {
        submittedPrompt: modelText,
      });
      act(() => {
        onBufferChange?.('');
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        modelText,
        false,
        'review this',
      );
    });

    it('separates edited restores from same-text history resubmissions', () => {
      const modelText =
        '<system-reminder>\nmanaged context\n</system-reminder>\n\nreview this';
      const mockQueueMessage = vi.fn();
      let onBufferChange: ((text: string) => void) | undefined;
      mockedUseTextBuffer.mockImplementation((options) => {
        onBufferChange = options.onChange;
        return {
          text: '',
          setText: vi.fn(),
        };
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [modelText],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(modelText),
        removeGoalTurns: vi.fn().mockReturnValue([]),
        popAllMessages: vi.fn().mockReturnValue({
          modelText,
          submittedPrompt: 'review this',
        }),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      act(() => {
        onBufferChange?.(`${modelText} with edits`);
        onBufferChange?.(modelText);
      });
      capturedUIActions.handleFinalSubmit(modelText, {
        submittedPrompt: modelText,
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        modelText,
        false,
        undefined,
      );

      mockQueueMessage.mockClear();
      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      capturedUIActions.handleFinalSubmit(`${modelText} with edits`, {
        submittedPrompt: `${modelText} with edits`,
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        `${modelText} with edits`,
        false,
        undefined,
      );

      mockQueueMessage.mockClear();
      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      capturedUIActions.handleFinalSubmit(`${modelText} `, {
        submittedPrompt: `${modelText} `,
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        `${modelText} `,
        false,
        undefined,
      );

      mockQueueMessage.mockClear();
      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      act(() => {
        onBufferChange?.(`${modelText} with edits`);
        onBufferChange?.('');
        onBufferChange?.('fresh prompt');
      });
      capturedUIActions.handleFinalSubmit('fresh prompt', {
        submittedPrompt: 'fresh prompt',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        'fresh prompt',
        false,
        'fresh prompt',
      );

      mockQueueMessage.mockClear();
      expect(capturedUIActions.popAllQueuedMessages()).toBe(modelText);
      capturedUIActions.invalidateSubmittedPromptProvenance();
      capturedUIActions.handleFinalSubmit(modelText, {
        submittedPrompt: modelText,
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        modelText,
        false,
        undefined,
      );
    });

    it('treats a restored prompt stash as provenance unavailable', () => {
      const stashedText =
        '<system-reminder>\ngenerated context\n</system-reminder>\n\nuser text';
      const mockQueueMessage = vi.fn();
      const setText = vi.fn();
      mockedUseTextBuffer.mockImplementation(() => ({
        text: '',
        setText,
      }));
      mockedRestorePromptStash.mockImplementation(
        (_targetDir, _currentText, onRestore) => {
          onRestore(stashedText);
          return true;
        },
      );
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(setText).toHaveBeenCalledWith(stashedText);
      capturedUIActions.handleFinalSubmit(stashedText, {
        submittedPrompt: stashedText,
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        stashedText,
        false,
        undefined,
      );
      expect(setText).toHaveBeenLastCalledWith('', {
        clearUndoHistory: true,
      });
      expect(setText).toHaveBeenCalledWith(stashedText);
      expect(setText).toHaveBeenCalledTimes(2);
    });

    it('clears restored prompt undo history after a manual clear', () => {
      const stashedText =
        '<system-reminder>\ngenerated context\n</system-reminder>\n\nuser text';
      const addMessage = vi.fn();
      let currentText = '';
      let onBufferChange: ((text: string) => void) | undefined;
      const setText = vi.fn((text: string) => {
        currentText = text;
      });
      mockedUseTextBuffer.mockImplementation((options) => {
        onBufferChange = options.onChange;
        return {
          get text() {
            return currentText;
          },
          setText,
        };
      });
      mockedRestorePromptStash.mockImplementation(
        (_targetDir, _currentText, onRestore) => {
          onRestore(stashedText);
          return true;
        },
      );
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      act(() => {
        currentText = '';
        onBufferChange?.('');
      });

      expect(setText).toHaveBeenLastCalledWith('', {
        clearUndoHistory: true,
      });

      capturedUIActions.handleFinalSubmit('fresh prompt', {
        submittedPrompt: 'fresh prompt',
      });
      expect(addMessage).toHaveBeenCalledWith(
        'fresh prompt',
        false,
        'fresh prompt',
      );
    });

    it('does not create provenance for a whitespace-only submission', () => {
      const mockQueueMessage = vi.fn();
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('   ', {
        submittedPrompt: '   ',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith('   ', false, undefined);
    });

    it('captures trimmed multiline Unicode input as provenance', () => {
      const mockQueueMessage = vi.fn();
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit(' \n你好 🌏\nsecond line \n ', {
        submittedPrompt: ' \n你好 🌏\nsecond line \n ',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        ' \n你好 🌏\nsecond line \n ',
        false,
        '你好 🌏\nsecond line',
      );
    });

    it('uses the explicit pre-attachment text as provenance', () => {
      const mockQueueMessage = vi.fn();
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit(
        '@.qwen/tmp/clipboard.png\n\ndescribe this image',
        { submittedPrompt: 'describe this image' },
      );

      expect(mockQueueMessage).toHaveBeenCalledWith(
        '@.qwen/tmp/clipboard.png\n\ndescribe this image',
        false,
        'describe this image',
      );
    });

    it('does not consume composer provenance for a programmatic submission', () => {
      const stashedText =
        '<system-reminder>\ngenerated context\n</system-reminder>\n\nuser text';
      const mockQueueMessage = vi.fn();
      const setText = vi.fn();
      mockedUseTextBuffer.mockImplementation(() => ({
        text: '',
        setText,
      }));
      mockedRestorePromptStash.mockImplementation(
        (_targetDir, _currentText, onRestore) => {
          onRestore(stashedText);
          return true;
        },
      );
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(setText).toHaveBeenCalledWith(stashedText);
      capturedUIActions.handleFinalSubmit('configured initial prompt');

      expect(mockQueueMessage).toHaveBeenCalledWith(
        'configured initial prompt',
        false,
        undefined,
      );
      expect(setText).toHaveBeenCalledTimes(1);

      capturedUIActions.handleFinalSubmit(stashedText, {
        submittedPrompt: stashedText,
      });
      expect(mockQueueMessage).toHaveBeenLastCalledWith(
        stashedText,
        false,
        undefined,
      );
      expect(setText).toHaveBeenCalledWith('', {
        clearUndoHistory: true,
      });
    });

    it('omits provenance while Vim mode is enabled', () => {
      const mockQueueMessage = vi.fn();
      mockedUseVimModeState.mockReturnValue({
        vimEnabled: true,
        vimMode: 'INSERT',
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('vim prompt', {
        submittedPrompt: 'vim prompt',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        'vim prompt',
        false,
        undefined,
      );
    });

    it('keeps Vim-modified composer text ineligible after Vim is disabled', () => {
      const mockQueueMessage = vi.fn();
      let setVimEnabled: ((enabled: boolean) => void) | undefined;
      mockedUseTextBuffer.mockImplementation(() => ({
        text: 'register contents',
        setText: vi.fn(),
      }));
      const useMockVimModeState = () => {
        const [vimEnabled, setEnabled] = useState(true);
        setVimEnabled = setEnabled;
        return {
          vimEnabled,
          vimMode: 'NORMAL',
        };
      };
      mockedUseVimModeState.mockImplementation(useMockVimModeState);
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      act(() => {
        setVimEnabled?.(false);
      });

      capturedUIActions.handleFinalSubmit('register contents', {
        submittedPrompt: 'register contents',
      });

      expect(mockQueueMessage).toHaveBeenCalledWith(
        'register contents',
        false,
        undefined,
      );
    });

    it.each(['exit', 'quit', ':q', ':q!', ':wq', ':wq!'])(
      'routes bare "%s" to /quit instead of sending as a message',
      (command) => {
        const mockHandleSlashCommand = vi.fn();
        const mockQueueMessage = vi.fn();

        mockedUseSlashCommandProcessor.mockReturnValue({
          handleSlashCommand: mockHandleSlashCommand,
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: null,
        });
        mockedUseMessageQueue.mockReturnValue({
          removeGoalTurns: vi.fn().mockReturnValue([]),
          messageQueue: [],
          addMessage: mockQueueMessage,
          clearQueue: vi.fn(),
          getQueuedMessagesText: vi.fn().mockReturnValue(''),
          popAllMessages: vi.fn().mockReturnValue(null),
          drainQueue: vi.fn().mockReturnValue([]),
          popNextTurn: vi.fn().mockReturnValue(null),
        });

        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );

        capturedUIActions.handleFinalSubmit(command);

        expect(mockHandleSlashCommand).toHaveBeenCalledWith('/quit');
        expect(mockQueueMessage).not.toHaveBeenCalled();
      },
    );

    it.each(['/quit', '/exit'])(
      'routes "%s" immediately while responding',
      (command) => {
        const mockHandleSlashCommand = vi.fn();
        const mockQueueMessage = vi.fn();
        mockedUseSlashCommandProcessor.mockReturnValue({
          handleSlashCommand: mockHandleSlashCommand,
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: null,
        });
        mockedUseGeminiStream.mockReturnValue({
          streamingState: StreamingState.Responding,
          submitQuery: vi.fn(),
          initError: null,
          pendingHistoryItems: [],
          thought: null,
          cancelOngoingRequest: vi.fn(),
          retryLastPrompt: vi.fn(),
          streamingResponseLengthRef: { current: 0 },
          isReceivingContent: false,
        });
        mockedUseMessageQueue.mockReturnValue({
          removeGoalTurns: vi.fn().mockReturnValue([]),
          messageQueue: [],
          addMessage: mockQueueMessage,
          clearQueue: vi.fn(),
          getQueuedMessagesText: vi.fn().mockReturnValue(''),
          popAllMessages: vi.fn().mockReturnValue(null),
          drainQueue: vi.fn().mockReturnValue([]),
          popNextTurn: vi.fn().mockReturnValue(null),
        });

        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );

        capturedUIActions.handleFinalSubmit(command);

        expect(mockHandleSlashCommand).toHaveBeenCalledWith('/quit');
        expect(mockQueueMessage).not.toHaveBeenCalled();
      },
    );
  });

  describe('Cancel Handler (issue #3204)', () => {
    // The cancel handler is wired through useGeminiStream's onCancelSubmit
    // arg (positional index 15 — see the useGeminiStream call site in
    // AppContainer.tsx). We capture it via mockImplementation so a future
    // signature change surfaces as a clear test failure rather than silently
    // grabbing the wrong callback.
    const ON_CANCEL_SUBMIT_ARG_INDEX = 15;
    // Shared ESC key fixture for the Cancel Handler describe block.
    const escKey: Key = {
      name: 'escape',
      sequence: '\u001b',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
    };
    type CapturedCancelSubmit = (info?: {
      pendingItem: HistoryItemWithoutId | null;
      lastTurnUserItem: {
        id: number;
        text: string;
        submittedPrompt?: string;
      } | null;
      canUndoLastLoggedUserMessage: boolean;
      turnProducedMeaningfulContent: boolean;
      wasGoalTurn?: boolean;
    }) => void;
    let capturedOnCancelSubmit: CapturedCancelSubmit | null = null;

    // Most cancel tests want auto-restore to be REACHABLE — the new
    // ownership guard requires the cancelled turn to have added a
    // matching user item. This helper builds the info object for the
    // common case (the cancelled turn added the user prompt in the
    // history fixture). Defaults to the fixture's id=1 so the tests
    // that use single-USER history fixtures work without parameterizing.
    const cancelInfoFor = (text: string, id = 1, submittedPrompt?: string) =>
      ({
        pendingItem: null,
        lastTurnUserItem: {
          id,
          text,
          ...(submittedPrompt === undefined ? {} : { submittedPrompt }),
        },
        canUndoLastLoggedUserMessage: true,
        turnProducedMeaningfulContent: false,
      }) as const;

    const installCancelCapture = (
      streamReturnValue: Record<string, unknown>,
    ) => {
      capturedOnCancelSubmit = null;
      mockedUseGeminiStream.mockImplementation((...args: unknown[]) => {
        const candidate = args[ON_CANCEL_SUBMIT_ARG_INDEX];
        if (typeof candidate === 'function') {
          capturedOnCancelSubmit = candidate as CapturedCancelSubmit;
        }
        return {
          ...streamReturnValue,
          streamingResponseLengthRef: { current: 0 },
          isReceivingContent: false,
        };
      });
    };

    const triggerCancel = (info?: Parameters<CapturedCancelSubmit>[0]) => {
      if (!capturedOnCancelSubmit) {
        throw new Error(
          `onCancelSubmit was not captured at arg index ${ON_CANCEL_SUBMIT_ARG_INDEX} — useGeminiStream signature may have changed`,
        );
      }
      capturedOnCancelSubmit(info);
    };

    it('does not fire outer cancel handler on Esc when vim is enabled in INSERT mode', async () => {
      mockedUseVimModeState.mockReturnValue({
        vimEnabled: true,
        vimMode: 'INSERT',
      });
      const cancelSpy = vi.fn();
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: cancelSpy,
        retryLastPrompt: vi.fn(),
      });
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      const handleKeypress = getGlobalKeypress();
      expect(handleKeypress).toBeDefined();

      handleKeypress!(escKey);

      // In vim INSERT mode, Esc must NOT trigger the outer cancel handler.
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('cancels the ongoing request on a single Esc with an empty buffer and queued follow-ups', async () => {
      // Positive counterpart to the vim-INSERT guard above: while the agent
      // is Responding and the buffer is empty, one Esc must reach the
      // cancel-work branch of the global handler. InputPrompt must NOT pop
      // the queue into the buffer on that Esc (its Responding guard skips
      // the pop; #8201). The global handler itself does not touch the
      // queue either — end-to-end the cancel path drains it back into the
      // buffer via the cancel handler, but that hop is severed here because
      // cancelOngoingRequest is replaced by a spy.
      const cancelSpy = vi.fn();
      const mockPopAllMessages = vi.fn().mockReturnValue(null);
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: cancelSpy,
        retryLastPrompt: vi.fn(),
      });
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: ['queued follow-up'],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue('queued follow-up'),
        popAllMessages: mockPopAllMessages,
        drainQueue: vi.fn().mockReturnValue(['queued follow-up']),
        popNextTurn: vi.fn().mockReturnValue({ modelText: 'queued follow-up' }),
        removeGoalTurns: vi.fn().mockReturnValue([]),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      const handleKeypress = getGlobalKeypress();
      expect(handleKeypress).toBeDefined();

      handleKeypress!(escKey);

      // A single Esc cancels the in-flight request...
      expect(cancelSpy).toHaveBeenCalledOnce();
      // ...and the global keypress handler itself must not pop the queue
      // (InputPrompt owns the ESC pop decision and skips it while Responding;
      // #8201). End-to-end the cancel path then drains the queue back into
      // the buffer via the cancel handler - that hop is severed here because
      // cancelOngoingRequest is replaced by a spy.
      expect(mockPopAllMessages).not.toHaveBeenCalled();
    });

    it('does not repopulate the buffer with the previous prompt on ESC cancel', async () => {
      const mockSetText = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      // Simulate logger returning a previously submitted prompt — this is
      // what the old buggy handler would read via userMessages.at(-1) and
      // unconditionally restore into the buffer.
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi
          .fn()
          .mockResolvedValue(['the previous prompt']),
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Let the userMessages-fetching effect resolve.
      await Promise.resolve();
      await Promise.resolve();

      triggerCancel();

      // Regression: the previous prompt must NOT be restored into the buffer.
      expect(mockSetText).not.toHaveBeenCalledWith('the previous prompt');
      // With no queued messages and no tool execution, the cancel handler
      // should leave the buffer untouched (so any in-progress typing the
      // user did since submitting is preserved).
      expect(mockSetText).not.toHaveBeenCalled();
    });

    it('moves queued follow-up messages into an empty buffer on cancel', async () => {
      const mockSetText = vi.fn();
      const mockPopAllMessages = vi
        .fn()
        .mockReturnValue({ modelText: 'queued follow-up' });
      const mockClearQueue = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi
          .fn()
          .mockResolvedValue(['the previous prompt']),
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: ['queued follow-up'],
        addMessage: vi.fn(),
        clearQueue: mockClearQueue,
        getQueuedMessagesText: vi.fn().mockReturnValue('queued follow-up'),
        popAllMessages: mockPopAllMessages,
        drainQueue: vi.fn().mockReturnValue(['queued follow-up']),
        popNextTurn: vi.fn().mockReturnValue({ modelText: 'queued follow-up' }),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel();

      // The queued message should be moved into the buffer for editing —
      // and crucially, it should NOT be prefixed with the previous prompt.
      expect(mockSetText).toHaveBeenCalledWith('queued follow-up');
      expect(mockSetText).not.toHaveBeenCalledWith(
        expect.stringContaining('the previous prompt'),
      );
      expect(mockPopAllMessages).toHaveBeenCalled();
      // popAllForEdit drains the queue internally, so the cancel handler
      // does not need to call clearQueue separately on this path.
      expect(mockClearQueue).not.toHaveBeenCalled();
    });

    it('releases queued Goal turn reservations on cancel using goal-turn keys', async () => {
      const releaseTurn = vi.fn().mockResolvedValue(undefined);
      const goalRuntime = {
        releaseTurn,
      } as unknown as ReturnType<Config['getGoalRuntime']>;
      vi.spyOn(mockConfig, 'getGoalRuntime').mockReturnValue(goalRuntime);
      const removeGoalTurns = vi.fn().mockReturnValue(['goal-runtime:turn-1']);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: vi.fn(),
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        removeGoalTurns,
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();

      triggerCancel();

      expect(removeGoalTurns).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(releaseTurn).toHaveBeenCalledWith('goal-runtime:turn-1'),
      );
    });

    it('auto-restores the just-submitted prompt when cancelling before any meaningful output', async () => {
      // claude-code parity: ESC immediately after submit (model produced
      // nothing) rewinds the user item + trailing INFO and pulls the prompt
      // text back into the input box. Up-arrow history is implicitly cleaned
      // because qwen-code's userMessages list is derived from the same
      // historyManager.history.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      const mockStripOrphans = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'what time is it?' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      // Extend the default GeminiClient mock with the orphan-strip
      // entry-point so the auto-restore branch's third cleanup leg can
      // be observed.
      vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        setTools: vi.fn().mockResolvedValue(undefined),
        isInitialized: vi.fn().mockReturnValue(false),
        stripOrphanedUserEntriesFromHistory: mockStripOrphans,
      } as unknown as GeminiClient);
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel(cancelInfoFor('what time is it?'));

      // User item (id=1) is the truncation target — slice removes it AND
      // the trailing INFO in the same render pass.
      expect(mockTruncateToItem).toHaveBeenCalledWith(1);
      expect(mockSetText).toHaveBeenCalledWith('what time is it?');
      // Cross-session ↑-history (disk-backed) is also cleaned.
      expect(mockRemoveLastUserMessage).toHaveBeenCalled();
      // Third cleanup leg: in-memory chat history is stripped so the
      // cancelled prompt doesn't ride along on the next request as an
      // orphan user turn.
      expect(mockStripOrphans).toHaveBeenCalled();
      // Fourth cleanup leg: Ink's static-rendered transcript region
      // is append-only — shrinking the underlying array doesn't unprint
      // already-flushed lines. `refreshStatic` writes the clear-terminal
      // escape so the cancelled `> prompt` actually disappears from
      // scrollback rather than appearing twice (transcript + input box).
      expect(mockStdout.write).toHaveBeenCalledWith(ansiEscapes.clearTerminal);
    });

    it('does not remove a newer BTW entry when restoring a cancelled main turn', async () => {
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      const mockStripOrphans = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'main prompt' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        setTools: vi.fn().mockResolvedValue(undefined),
        isInitialized: vi.fn().mockReturnValue(false),
        stripOrphanedUserEntriesFromHistory: mockStripOrphans,
      } as unknown as GeminiClient);
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel({
        ...cancelInfoFor('main prompt'),
        canUndoLastLoggedUserMessage: false,
      });

      expect(mockTruncateToItem).toHaveBeenCalledWith(1);
      expect(mockSetText).toHaveBeenCalledWith('main prompt');
      expect(mockStripOrphans).toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('strips the orphaned continuation prompt when a Goal turn is cancelled', async () => {
      const mockStripOrphans = vi.fn();
      const mockTruncateToItem = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: vi.fn(),
      });
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'info', text: 'Request cancelled.' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: vi.fn().mockResolvedValue(true),
      });
      vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
        setTools: vi.fn().mockResolvedValue(undefined),
        isInitialized: vi.fn().mockReturnValue(false),
        stripOrphanedUserEntriesFromHistory: mockStripOrphans,
      } as unknown as GeminiClient);
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // A Goal continuation turn adds no UI user item, so lastTurnUserItem is
      // null and the auto-restore branch (with its own orphan strip) bails.
      // wasGoalTurn must trigger the strip independently so the synthetic
      // "no new real user input" prompt can't merge into the next message.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: null,
        canUndoLastLoggedUserMessage: false,
        turnProducedMeaningfulContent: false,
        wasGoalTurn: true,
      });

      expect(mockStripOrphans).toHaveBeenCalled();
      // Auto-restore itself bailed: there was no user item to rewind.
      expect(mockTruncateToItem).not.toHaveBeenCalled();
    });

    it('reuses the cancelled turn provenance on an unchanged resubmit', async () => {
      const modelText =
        '<system-reminder>\nmanaged context\n</system-reminder>\n\nreview this';
      const mockSetText = vi.fn();
      const mockQueueMessage = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: modelText },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: vi.fn(),
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: vi.fn().mockResolvedValue(true),
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel(cancelInfoFor(modelText, 1, 'review this'));
      capturedUIActions.handleFinalSubmit(modelText, {
        submittedPrompt: modelText,
      });

      expect(mockSetText).toHaveBeenCalledWith(modelText);
      expect(mockQueueMessage).toHaveBeenCalledWith(
        modelText,
        false,
        'review this',
      );
    });

    it('does not auto-restore when the cancelled turn did not add a user item (e.g. Cron / slash submit_prompt)', async () => {
      // Some submit paths (SendMessageType.Cron, slash submit_prompt) run
      // through useGeminiStream without pushing a `user` history item.
      // If history happens to end with an older user prompt followed only
      // by synthetic items (e.g. info), the auto-restore guard must NOT
      // wrongly truncate/restore that older prompt on behalf of the
      // cancelled non-USER turn. info.lastTurnUserItem === null is the
      // signal.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'an older prompt' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // No lastTurnUserItem → guard must bail even though the trailing
      // slice looks restore-eligible.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: null,
        canUndoLastLoggedUserMessage: false,
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when the lastTurnUserItem text does not match the candidate user item (sanity)', async () => {
      // Defensive: even if both sides report a USER from "this turn",
      // a text mismatch (impossible in practice without intervening
      // concurrent turns) must bail rather than rewind the wrong item.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'in history' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Text mismatch even though id collides — guard bails.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: { id: 1, text: 'a different text' },
        canUndoLastLoggedUserMessage: true,
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('restores the prompt without rewinding when the model produced meaningful content', async () => {
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'what time is it?' },
          { id: 2, type: 'gemini_content', text: '12:00pm' },
          { id: 3, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Pass matching lastTurnUserItem so we reach the
      // trailing-only-synthetic guard (the one the test name promises).
      triggerCancel(cancelInfoFor('what time is it?'));

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).toHaveBeenCalledWith('what time is it?');
    });

    it('does not auto-restore when the sync pendingItem snapshot has meaningful content (closes stale-state race)', async () => {
      // Race scenario from PR review: stream chunk arrives → cancelOngoingRequest
      // commits via addItem → fires onCancelSubmit before React re-renders, so
      // the consumer's pendingGeminiHistoryItems prop reads as [] even though
      // pendingHistoryItemRef.current was non-null. The synchronous snapshot
      // passed via info.pendingItem must override the stale React-state copy.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'what time is it?' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        // React-state pending is empty (the race window).
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Simulate cancelOngoingRequest passing the just-arrived (uncommitted)
      // pending item via the sync snapshot.
      capturedOnCancelSubmit!({
        pendingItem: {
          type: 'gemini_content',
          text: 'partial reply…',
        },
        lastTurnUserItem: { id: 1, text: 'what time is it?' },
        canUndoLastLoggedUserMessage: true,
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('restores the prompt without rewinding when turnProducedMeaningfulContent is true', async () => {
      // Race scenario flagged in PR review: pre-cancel flush commits a
      // gemini_content via addItem and then a synthetic thought event
      // replaces pendingHistoryItem. AppContainer's historyRef.current
      // doesn't see the committed content yet (React hasn't
      // re-rendered), so the trailing-only-synthetic check would
      // otherwise pass. `info.turnProducedMeaningfulContent: true`
      // must preserve the output and restore only the prompt text.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'what time is it?' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [], // stale — content already committed in flush
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // pendingItem is a synthetic thought, but meaningful content happened
      // earlier. Preserve that output while restoring only the prompt text.
      triggerCancel({
        pendingItem: { type: 'gemini_thought', text: 'thinking…' },
        lastTurnUserItem: { id: 1, text: 'what time is it?' },
        canUndoLastLoggedUserMessage: true,
        turnProducedMeaningfulContent: true,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).toHaveBeenCalledWith('what time is it?');
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when lastTurnUserItem.id does not match the candidate user item (catches addItem dedup)', async () => {
      // Regression for the consecutive-duplicate path: `useHistoryManager.addItem`
      // skips inserting a USER row whose text equals the last item's,
      // but still returns a freshly-generated id. If the auto-restore
      // guard compared text only, a re-submitted identical prompt would
      // wrongly match the OLDER USER row.
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'foo' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Same text but a different (later) id — addItem skipped the
      // insert, but the producer-side ref still recorded the
      // freshly-generated id. Guard bails on id mismatch even though
      // text matches.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: { id: 999, text: 'foo' },
        canUndoLastLoggedUserMessage: true,
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when the user typed text after submitting (preserves the draft)', async () => {
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: 'follow-up I am typing',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'what time is it?' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Matching lastTurnUserItem so the test reaches the
      // buffer-non-empty bail path (the one the test name promises).
      triggerCancel(cancelInfoFor('what time is it?'));

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when the user queued a follow-up (drains queue but keeps prompt)', async () => {
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [
          { id: 1, type: 'user', text: 'what time is it?' },
          { id: 2, type: 'info', text: 'Request cancelled.' },
        ],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: ['queued thought'],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue('queued thought'),
        popAllMessages: vi
          .fn()
          .mockReturnValue({ modelText: 'queued thought' }),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue({ modelText: 'queued thought' }),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Matching lastTurnUserItem so the test reaches the
      // queue-non-empty bail path.
      triggerCancel(cancelInfoFor('what time is it?'));

      // Queue drained to buffer, but prompt NOT undone.
      expect(mockSetText).toHaveBeenCalledWith('queued thought');
      expect(mockSetText).not.toHaveBeenCalledWith('what time is it?');
      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when a tool_group is pending (covers tool-execution cancel)', async () => {
      const mockSetText = vi.fn();
      const mockTruncateToItem = vi.fn();
      const mockRemoveLastUserMessage = vi.fn().mockResolvedValue(true);
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'edit foo.ts' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: mockTruncateToItem,
      });
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        removeLastUserMessage: mockRemoveLastUserMessage,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-1',
                name: 'replace',
                description: 'edit foo.ts',
                status: ToolCallStatus.Executing,
                resultDisplay: undefined,
                confirmationDetails: undefined,
                renderOutputAsMarkdown: false,
              },
            ],
          },
        ],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      // Matching lastTurnUserItem so the test reaches the
      // pending-tool-group bail path (the one the test name promises).
      triggerCancel({
        ...cancelInfoFor('edit foo.ts'),
        turnProducedMeaningfulContent: true,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('preserves the queue into the buffer when cancelling during tool execution', async () => {
      // Simulates: user asks for a shell tool (e.g. sleep 30), queues
      // `/model` and `hi` while the tool is running, then hits Ctrl+C.
      // The cancel must drain the queue back into the buffer (so the user
      // can edit or delete it) instead of silently dropping it. This still
      // resolves issue #3204 (no auto-fire after tool settles) because the
      // queue ends up empty — but without losing the user's queued work.
      // Mirrors claude-code's popAllEditable behaviour.
      const mockSetText = vi.fn();
      const mockClearQueue = vi.fn();
      const mockPopAllMessages = vi
        .fn()
        .mockReturnValue({ modelText: '/model\n\nhi' });
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-1',
                name: 'run_shell_command',
                description: 'sleep 30',
                status: ToolCallStatus.Executing,
                resultDisplay: undefined,
                confirmationDetails: undefined,
                renderOutputAsMarkdown: false,
              },
            ],
          },
        ],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: ['/model', 'hi'],
        addMessage: vi.fn(),
        clearQueue: mockClearQueue,
        getQueuedMessagesText: vi.fn().mockReturnValue('/model\n\nhi'),
        popAllMessages: mockPopAllMessages,
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue({ modelText: '/model' }),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel();

      // Queue moved into buffer for editing; popAllMessages drains the
      // queue internally so clearQueue is not called separately.
      expect(mockPopAllMessages).toHaveBeenCalled();
      expect(mockSetText).toHaveBeenCalledWith('/model\n\nhi');
      expect(mockSetText).not.toHaveBeenCalledWith('');
      expect(mockClearQueue).not.toHaveBeenCalled();
    });

    it('preserves an in-progress draft when restoring queued messages on cancel', async () => {
      // Simulates: user submits P1, queues P2, then types draft P3, then
      // hits Ctrl+C. The Ctrl+C cancel path (unlike ESC) does NOT pre-clear
      // the buffer, so P3 must be preserved.
      const mockSetText = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: 'in-progress draft',
        setText: mockSetText,
      });
      installCancelCapture({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: ['queued follow-up'],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue('queued follow-up'),
        popAllMessages: vi
          .fn()
          .mockReturnValue({ modelText: 'queued follow-up' }),
        drainQueue: vi.fn().mockReturnValue(['queued follow-up']),
        popNextTurn: vi.fn().mockReturnValue({ modelText: 'queued follow-up' }),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await Promise.resolve();
      await Promise.resolve();

      triggerCancel();

      // Queued text is prepended to the existing draft (matches the
      // popQueueIntoInput convention used elsewhere in the input prompt).
      expect(mockSetText).toHaveBeenCalledWith(
        'queued follow-up\nin-progress draft',
      );
    });
  });

  describe('Settings Integration', () => {
    it('handles settings with all display options disabled', () => {
      const settingsAllHidden = {
        merged: {
          hideTips: true,
        },
      } as unknown as LoadedSettings;

      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={settingsAllHidden}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('initializes Markdown render mode from ui.renderMode', () => {
      const rawSettings = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            renderMode: 'raw',
          },
        },
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={rawSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedRenderMode).toBe('raw');
    });

    it('falls back to rendered Markdown mode for missing or invalid ui.renderMode', () => {
      const invalidSettings = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            renderMode: 'unsupported',
          },
        },
      } as unknown as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={invalidSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedRenderMode).toBe('render');
    });

    it('computes render mode toggles from the global render shortcut', () => {
      const optionMKey: Key = {
        name: 'm',
        ctrl: false,
        meta: true,
        shift: false,
        paste: false,
        sequence: '\u001bm',
      };

      expect(isRenderModeToggleKey(optionMKey)).toBe(true);
      expect(getNextRenderMode('render')).toBe('raw');
      expect(getNextRenderMode(getNextRenderMode('render'))).toBe('render');
    });

    it('handles global render mode shortcut through the captured keypress handler', async () => {
      const optionMKey: Key = {
        name: 'm',
        ctrl: false,
        meta: true,
        shift: false,
        paste: false,
        sequence: '\u001bm',
      };

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedRenderMode).toBe('render');
      await Promise.resolve();
      await Promise.resolve();
      const handleKeypress = mockedUseKeypress.mock.calls
        .map((call) => call[0])
        .reverse()
        .find(
          (handler): handler is (key: Key) => void =>
            typeof handler === 'function' &&
            handler.toString().includes('handleRenderModeToggleKey'),
        ) as ((key: Key) => void) | undefined;
      expect(handleKeypress).toBeDefined();
      expect(() => handleKeypress!(optionMKey)).not.toThrow();
    });
  });

  describe('Version Handling', () => {
    it.each(['1.0.0', '2.1.3-beta', '3.0.0-nightly'])(
      'handles version format: %s',
      (version) => {
        expect(() => {
          render(
            <AppContainer
              config={mockConfig}
              settings={mockSettings}
              version={version}
              initializationResult={mockInitResult}
            />,
          );
        }).not.toThrow();
      },
    );
  });

  describe('Error Handling', () => {
    it('handles config methods that might throw', () => {
      const errorConfig = makeFakeConfig();
      vi.spyOn(errorConfig, 'getModel').mockImplementation(() => {
        throw new Error('Config error');
      });

      // Should still render without crashing - errors should be handled internally
      expect(() => {
        render(
          <AppContainer
            config={errorConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });

    it('handles undefined settings gracefully', () => {
      const undefinedSettings = {
        merged: {},
      } as LoadedSettings;

      expect(() => {
        render(
          <AppContainer
            config={mockConfig}
            settings={undefinedSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      }).not.toThrow();
    });
  });

  describe('Provider Hierarchy', () => {
    it('establishes correct provider nesting order', () => {
      // This tests that all the context providers are properly nested
      // and that the component tree can be built without circular dependencies
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Terminal Title Update Feature', () => {
    /**
     * Helper to build the expected padded OSC title escape sequence.
     * writeTerminalTitle pads the title to 80 characters with trailing
     * spaces and writes both \x1b]0; (icon+title) and \x1b]2; (title).
     */
    const titleEscape = (title: string) => {
      const padded = title.padEnd(80, ' ');
      return `\x1b]0;${padded}\x07\x1b]2;${padded}\x07`;
    };

    beforeEach(() => {
      vi.stubEnv('TMUX', undefined);
      vi.stubEnv('STY', undefined);
      vi.stubEnv('ZELLIJ', undefined);
      vi.stubEnv('DVTM', undefined);
      // Reset mock stdout for each test. The title useEffect now uses
      // process.stdout.write directly (to avoid Ink proxy corruption of
      // OSC escape sequences), so we spy on that.
      mockStdout = { write: vi.fn() };
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it('should not update terminal title when showStatusInTitle is false', () => {
      // Arrange: Set up mock settings with showStatusInTitle disabled
      const mockSettingsWithShowStatusFalse = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: false,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithShowStatusFalse}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that no title-related writes occurred
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(0);
      unmount();
    });

    it('should not update terminal title when hideWindowTitle is true', () => {
      // Arrange: Set up mock settings with hideWindowTitle enabled
      const mockSettingsWithHideTitleTrue = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: true,
          },
        },
      } as unknown as LoadedSettings;

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithHideTitleTrue}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that no title-related writes occurred
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(0);
      unmount();
    });

    it('should keep default terminal title when active without a session name', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock the streaming state and thought
      const thoughtSubject = 'Processing request';
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: { subject: thoughtSubject },
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that title uses the default (not thought subject)
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        titleEscape(`${ICON.CIRCLE_LEFT_HALF} Qwen - workspace`),
      );
      unmount();
    });

    it('should update terminal title with default text when in Idle state and no thought subject', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock the streaming state as Idle with no thought
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that title was updated with default text
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(titleEscape('Qwen - workspace'));
      unmount();
    });

    it('should keep default terminal title when waiting for confirmation without a session name', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock the streaming state and thought
      const thoughtSubject = 'Confirm tool execution';
      mockedUseGeminiStream.mockReturnValue({
        streamingState: StreamingState.WaitingForConfirmation,
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: { subject: thoughtSubject },
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that confirmation status does not replace the session title
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        titleEscape(`${ICON.SPARKLE} Qwen - workspace`),
      );
      unmount();
    });

    it('should pad the terminal title to 80 characters', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock the streaming state and thought with a short subject
      const shortTitle = 'Short';
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: { subject: shortTitle },
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that title is padded to exactly 80 characters
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      const calledWith = titleWrites[0][0];
      expect(calledWith).toContain('Qwen - workspace');
      expect(calledWith).toContain('\x1b]0;');
      expect(calledWith).toContain('\x1b]2;');
      expect(calledWith).toContain('\x07');
      expect(calledWith).toBe(
        titleEscape(`${ICON.CIRCLE_LEFT_HALF} Qwen - workspace`),
      );
      unmount();
    });

    it('should use correct ANSI escape code format with padding', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock the streaming state and thought
      const title = 'Test Title';
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: { subject: title },
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: Check that the correct ANSI escape sequence is used
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        titleEscape(`${ICON.CIRCLE_LEFT_HALF} Qwen - workspace`),
      );
      unmount();
    });

    it('should format terminal title from CLI_TITLE when set', () => {
      // Arrange: Set up mock settings with showStatusInTitle enabled
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      // Mock CLI_TITLE environment variable
      vi.stubEnv('CLI_TITLE', 'Custom Title');

      // Mock the streaming state as Idle with no thought
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      // Act: Render the container
      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: formatSessionWindowTitle falls back to computeWindowTitle()
      // which respects CLI_TITLE, so the custom title appears padded to 80 chars.
      const titleWrites = (
        process.stdout.write as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call: string[]) => call[0].includes('\x1b]2;'));
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(titleEscape('Custom Title'));
      unmount();
    });

    it('should register for recorded session titles and format them in the terminal title', async () => {
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      type TitleRecordedCallback = (
        customTitle: string,
        source: string,
        sessionId: string,
      ) => void;
      let titleRecordedCallback: TitleRecordedCallback | undefined;
      let registeredTitleRecordedCallback: TitleRecordedCallback | undefined;
      const setTitleRecordedCallback = vi.fn(
        (callback: TitleRecordedCallback | undefined) => {
          titleRecordedCallback = callback;
          if (callback) {
            registeredTitleRecordedCallback = callback;
          }
        },
      );
      const getTitleRecordedCallback = vi.fn(() => titleRecordedCallback);
      vi.spyOn(mockConfig, 'getChatRecordingService').mockReturnValue({
        setTitleRecordedCallback,
        getTitleRecordedCallback,
      } as unknown as NonNullable<
        ReturnType<Config['getChatRecordingService']>
      >);

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(registeredTitleRecordedCallback).toBeDefined();

      // Invoke the callback to exercise the full chain:
      // recording service fires callback → setSessionName('Fix terminal title')
      // → React re-render → title useEffect calls writeTerminalTitle
      //
      // Note: React 19's effect batching in the ink-testing-library
      // environment prevents asserting the writeTerminalTitle call
      // inline (effects are not flushed inside act()). The downstream
      // title write is verified by the other tests that render
      // AppContainer with different settings and assert the output via
      // process.stdout.write.
      expect(registeredTitleRecordedCallback).toStrictEqual(
        expect.any(Function),
      );
      const currentSessionId = mockConfig.getSessionId();
      await act(async () => {
        registeredTitleRecordedCallback!(
          'Fix terminal title',
          'manual',
          currentSessionId,
        );
      });
      // The initial render wrote the default title; after the callback
      // the next writeTerminalTitle call (when effects flush) should
      // carry the session name. We validate the logic standalone:
      expect(formatSessionWindowTitle('Fix terminal title')).toBe(
        'Fix terminal title',
      );
      // When null, falls back to computeWindowTitle() which returns
      // 'Qwen - qwen' when CLI_TITLE is not set.
      expect(formatSessionWindowTitle(null)).toBe('Qwen - qwen');
      // When null with a folder name, adds the Qwen prefix.
      expect(formatSessionWindowTitle(null, 'my-project')).toBe(
        'Qwen - my-project',
      );
      // Session names with control characters are sanitized at entry point.
      expect(formatSessionWindowTitle('Bad\x07Title')).toBe('BadTitle');
      unmount();
      expect(titleRecordedCallback).toBeUndefined();
    });

    it('should chain with existing titleRecordedCallback from Session (ACP notifications)', async () => {
      const mockSettingsWithTitleEnabled = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            showStatusInTitle: true,
            hideWindowTitle: false,
          },
        },
      } as unknown as LoadedSettings;

      const existingCallback = vi.fn();
      type TitleRecordedCallback = (
        customTitle: string,
        source: string,
        sessionId: string,
      ) => void;
      let titleRecordedCallback: TitleRecordedCallback | undefined;
      const setTitleRecordedCallback = vi.fn(
        (callback: TitleRecordedCallback | undefined) => {
          titleRecordedCallback = callback;
        },
      );
      // Simulate Session having already registered an ACP callback
      const getTitleRecordedCallback = vi.fn(() => existingCallback);
      vi.spyOn(mockConfig, 'getChatRecordingService').mockReturnValue({
        setTitleRecordedCallback,
        getTitleRecordedCallback,
      } as unknown as NonNullable<
        ReturnType<Config['getChatRecordingService']>
      >);

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettingsWithTitleEnabled}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });

      // The chained callback should exist
      expect(titleRecordedCallback).toBeDefined();

      // Invoke the chained callback — it should call both the existing
      // ACP callback AND the new setSessionName setter
      const currentSessionId = mockConfig.getSessionId();
      await act(async () => {
        titleRecordedCallback!('Test title', 'rename', currentSessionId);
      });

      // The existing ACP callback was called (preserved by chaining)
      expect(existingCallback).toHaveBeenCalledWith(
        'Test title',
        'rename',
        currentSessionId,
      );
      await act(async () => {
        titleRecordedCallback!('Stale title', 'auto', 'old-session-id');
      });
      expect(existingCallback).toHaveBeenLastCalledWith(
        'Stale title',
        'auto',
        'old-session-id',
      );

      unmount();
      // After unmount, the callback should be restored to the original
      expect(titleRecordedCallback).toBe(existingCallback);
    });

    it('should revert to static title when showStatusInTitle toggles from true to false', () => {
      // The revert logic in the useEffect calls formatSessionWindowTitle(null, folderName)
      // when showStatusInTitle changes from true to false. This test verifies the
      // formatting function produces the correct static fallback.
      const folderName = 'my-project';

      // When sessionName is null (revert case), should use computeWindowTitle fallback
      const staticTitle = formatSessionWindowTitle(null, folderName);
      expect(staticTitle).toBe('Qwen - my-project');

      // When CLI_TITLE is set, it should use that instead
      vi.stubEnv('CLI_TITLE', 'Custom Title');
      const staticTitleWithEnv = formatSessionWindowTitle(null, folderName);
      expect(staticTitleWithEnv).toBe('Custom Title');
      vi.stubEnv('CLI_TITLE', undefined);

      // Verify the escape sequence format for the static title
      const writeSpy = vi.fn();
      writeTerminalTitle(writeSpy, staticTitle);
      const padded = staticTitle.padEnd(80, ' ');
      expect(writeSpy).toHaveBeenCalledWith(
        expect.stringContaining(`\x1b]2;${padded}\x07`),
      );
    });
  });

  describe('Terminal Height Calculation', () => {
    const mockedMeasureElement = measureElement as Mock;
    const mockedUseTerminalSize = useTerminalSize as Mock;
    const makeTodoHistory = (
      status: 'pending' | 'in_progress' | 'completed',
    ): HistoryItem[] => [
      {
        type: 'tool_group',
        id: 1,
        tools: [
          {
            callId: 'todo-1',
            name: 'TodoWrite',
            description: 'Update todos',
            resultDisplay: {
              type: 'todo_list',
              todos: [
                {
                  id: 'todo-1',
                  content: 'Run focused tests',
                  status,
                },
              ],
            },
            status: ToolCallStatus.Success,
            confirmationDetails: undefined,
          },
        ],
      },
      {
        type: 'gemini',
        id: 2,
        text: 'First response after todo',
      },
      {
        type: 'gemini',
        id: 3,
        text: 'Second response after todo',
      },
    ];

    it('should prevent terminal height from being less than 1', () => {
      const resizePtySpy = vi.spyOn(ShellExecutionService, 'resizePty');
      // Arrange: Simulate a small terminal and a large footer
      mockedUseTerminalSize.mockReturnValue({ columns: 80, rows: 5 });
      mockedMeasureElement.mockReturnValue({ width: 80, height: 10 }); // Footer is taller than the screen

      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        activePtyId: 'some-id',
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Assert: The shell should be resized to a minimum height of 1, not a negative number.
      // The old code would have tried to set a negative height.
      expect(resizePtySpy).toHaveBeenCalled();
      const lastCall =
        resizePtySpy.mock.calls[resizePtySpy.mock.calls.length - 1];
      // Check the height argument specifically
      expect(lastCall[2]).toBe(1);
    });

    it('loads a collapsed summary into history on cold-boot resume when collapseOnResume is enabled', async () => {
      const historyManager = {
        history: [] as HistoryItem[],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn((items: HistoryItem[]) => {
          historyManager.history = items;
        }),
        truncateToItem: vi.fn(),
      };
      mockedUseHistory.mockReturnValue(historyManager);

      const resumeSessionData = {
        conversation: {
          sessionId: 'session-1',
          projectHash: 'test-project-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:01Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId: 'session-1',
              timestamp: '2024-01-01T00:00:00Z',
              type: 'user',
              message: { role: 'user', parts: [{ text: 'hello' }] },
              cwd: '/test/workspace',
              version: '1.0.0',
            },
            {
              uuid: 'a1',
              parentUuid: 'u1',
              sessionId: 'session-1',
              timestamp: '2024-01-01T00:00:01Z',
              type: 'assistant',
              message: { role: 'model', parts: [{ text: 'world' }] },
              cwd: '/test/workspace',
              version: '1.0.0',
            },
          ],
        },
        filePath: '/tmp/session.jsonl',
        lastCompletedUuid: 'a1',
      };

      vi.spyOn(mockConfig, 'getContentGenerator').mockReturnValue(
        {} as unknown as ReturnType<typeof mockConfig.getContentGenerator>,
      );
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
      vi.spyOn(mockConfig, 'getResumedSessionData').mockReturnValue(
        resumeSessionData as ReturnType<
          typeof mockConfig.getResumedSessionData
        >,
      );
      vi.spyOn(mockConfig, 'loadPausedBackgroundAgents').mockResolvedValue([]);

      mockSettings = {
        ...mockSettings,
        merged: {
          ...mockSettings.merged,
          ui: {
            ...mockSettings.merged.ui,
            history: {
              collapseOnResume: true,
            },
          },
        },
      } as LoadedSettings;

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      await vi.waitFor(() => {
        expect(historyManager.loadHistory).toHaveBeenCalled();
      });

      expect(historyManager.loadHistory).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ display: { kind: 'collapse-summary' } }),
        ]),
      );
      expect(historyManager.history.at(-1)).toMatchObject({
        type: 'info',
        display: { kind: 'collapse-summary' },
      });
      expect(
        historyManager.history
          .slice(0, -1)
          .every((item) => item.display?.suppressOnRestore === true),
      ).toBe(true);
    });

    it('does not remeasure footer height for sticky todo status-only updates', async () => {
      // Scoped stub: makeFakeConfig().initialize() rejects on React's
      // double-mount, which leaks async renders and destabilizes the
      // footer-measurement timing this test depends on. Kept per-test so
      // unrelated tests in this block still exercise the real init gate.
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);

      const historyManager = {
        history: makeTodoHistory('pending'),
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: vi.fn(),
      };
      mockedUseHistory.mockReturnValue(historyManager);
      mockedUseTerminalSize.mockReturnValue({ columns: 80, rows: 24 });
      mockedMeasureElement.mockReturnValue({ width: 80, height: 4 });

      let view: ReturnType<typeof render>;
      await act(async () => {
        view = render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      });

      // Let any pending state updates from useLayoutEffect settle.
      await act(async () => {
        view!.rerender(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      });

      const heightAfterSettle = capturedUIState.availableTerminalHeight;

      // Switch the mock to a different height so any re-measurement triggered
      // by the status-only rerender below would change controlsHeight (and
      // therefore availableTerminalHeight). Without this, the production
      // same-value short-circuit on setControlsHeight makes the equality
      // assertion pass even when the optimization regresses.
      mockedMeasureElement.mockReturnValue({ width: 80, height: 10 });

      historyManager.history = makeTodoHistory('in_progress');
      await act(async () => {
        view!.rerender(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      });

      // The sticky todo status change (pending → in_progress) must not alter
      // the computed terminal height. Combined with the mock-height swap
      // above, this fails iff the footer was re-measured.
      expect(capturedUIState.availableTerminalHeight).toBe(heightAfterSettle);
    });
  });

  describe('Keyboard Input Handling', () => {
    it('should block quit command during authentication', () => {
      mockedUseAuthCommand.mockReturnValue({
        authState: 'unauthenticated',
        setAuthState: vi.fn(),
        authError: null,
        onAuthError: vi.fn(),
        isAuthDialogOpen: false,
        isAuthenticating: true,
        pendingAuthType: undefined,
        externalAuthState: null,
        qwenAuthState: {
          deviceAuth: null,
          authStatus: 'idle',
          authMessage: null,
        },
        state: {
          authError: null,
          isAuthDialogOpen: false,
          isAuthenticating: true,
          pendingAuthType: undefined,
          externalAuthState: null,
          qwenAuthState: {
            deviceAuth: null,
            authStatus: 'idle',
            authMessage: null,
          },
        },
        closeAuthDialog: vi.fn(),
        handleProviderSubmit: vi.fn(),
        openAuthDialog: vi.fn(),
        cancelAuthentication: vi.fn(),
        actions: {
          setAuthState: vi.fn(),
          onAuthError: vi.fn(),
          closeAuthDialog: vi.fn(),
          handleProviderSubmit: vi.fn(),
          openAuthDialog: vi.fn(),
          cancelAuthentication: vi.fn(),
        },
      });

      const mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');
    });

    it('should prevent exit command when text buffer has content', () => {
      mockedUseTextBuffer.mockReturnValue({
        text: 'some user input',
        setText: vi.fn(),
      });

      const mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');
    });

    it('should require double Ctrl+C to exit when dialogs are open', () => {
      vi.useFakeTimers();

      mockedUseThemeCommand.mockReturnValue({
        isThemeDialogOpen: true,
        openThemeDialog: vi.fn(),
        handleThemeSelect: vi.fn(),
        handleThemeHighlight: vi.fn(),
      });

      const mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');

      vi.useRealTimers();
    });

    it('should cancel ongoing request on first Ctrl+C', () => {
      const mockCancelOngoingRequest = vi.fn();
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: mockCancelOngoingRequest,
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      const mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');
    });

    it('should reset Ctrl+C state after timeout', () => {
      vi.useFakeTimers();

      const mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');

      vi.advanceTimersByTime(1001);

      expect(mockHandleSlashCommand).not.toHaveBeenCalledWith('/quit');

      vi.useRealTimers();
    });

    it('Ctrl+B promotes the running foreground shell tool call (#3831 PR-3)', () => {
      // E2E for the keybind layer: Ctrl+B during an executing shell
      // tool call must call abort({ kind: 'background' }) on the
      // tool call's promoteAbortController. ShellExecutionService +
      // shell.ts (covered by PR-1 / PR-2 unit tests) translate the
      // abort reason into a registry-registered BackgroundShellEntry.
      const promoteAc = new AbortController();
      const abortSpy = vi.spyOn(promoteAc, 'abort');
      const executingShell = {
        status: 'executing',
        request: { callId: 'call-shell-1', name: 'run_shell_command' },
        promoteAbortController: promoteAc,
      };
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        pendingToolCalls: [executingShell],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Find the global keypress handler. AppContainer registers
      // multiple via useKeypress (text buffer, dialogs, etc.); the
      // global one is identifiable by its body — it references the
      // PROMOTE_SHELL_TO_BACKGROUND command we just added.
      const handleKeypress = mockedUseKeypress.mock.calls
        .map((call) => call[0])
        .reverse()
        .find(
          (handler): handler is (key: Key) => void =>
            typeof handler === 'function' &&
            handler.toString().includes('PROMOTE_SHELL_TO_BACKGROUND'),
        ) as ((key: Key) => void) | undefined;
      expect(handleKeypress).toBeDefined();

      // Fire Ctrl+B.
      const ctrlBKey: Key = {
        name: 'b',
        ctrl: true,
        meta: false,
        shift: false,
        paste: false,
        sequence: '\x02',
      };
      handleKeypress!(ctrlBKey);

      expect(abortSpy).toHaveBeenCalledTimes(1);
      const reason = abortSpy.mock.calls[0][0];
      expect(reason).toEqual({ kind: 'background' });
    });

    it('Ctrl+B does NOT promote when multiple foreground shell tool calls are executing', () => {
      const promoteAc1 = new AbortController();
      const promoteAc2 = new AbortController();
      const abortSpy1 = vi.spyOn(promoteAc1, 'abort');
      const abortSpy2 = vi.spyOn(promoteAc2, 'abort');
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        pendingToolCalls: [
          {
            status: 'executing',
            request: { callId: 'call-shell-1', name: 'run_shell_command' },
            promoteAbortController: promoteAc1,
          },
          {
            status: 'executing',
            request: { callId: 'call-shell-2', name: 'run_shell_command' },
            promoteAbortController: promoteAc2,
          },
        ],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      const handleKeypress = mockedUseKeypress.mock.calls
        .map((call) => call[0])
        .reverse()
        .find(
          (handler): handler is (key: Key) => void =>
            typeof handler === 'function' &&
            handler.toString().includes('PROMOTE_SHELL_TO_BACKGROUND'),
        ) as ((key: Key) => void) | undefined;
      expect(handleKeypress).toBeDefined();

      handleKeypress!({
        name: 'b',
        ctrl: true,
        meta: false,
        shift: false,
        paste: false,
        sequence: '\x02',
      });

      expect(abortSpy1).not.toHaveBeenCalled();
      expect(abortSpy2).not.toHaveBeenCalled();
    });

    it('Ctrl+B is a no-op when no foreground shell is currently executing', () => {
      // Pin the safety contract: pressing Ctrl+B mid-prompt with no
      // pending tool calls must NOT throw — falls through to the input
      // layer's own Ctrl+B (cursor-left).
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        pendingToolCalls: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      const handleKeypress = mockedUseKeypress.mock.calls
        .map((call) => call[0])
        .reverse()
        .find(
          (handler): handler is (key: Key) => void =>
            typeof handler === 'function' &&
            handler.toString().includes('PROMOTE_SHELL_TO_BACKGROUND'),
        ) as ((key: Key) => void) | undefined;
      expect(handleKeypress).toBeDefined();

      const ctrlBKey: Key = {
        name: 'b',
        ctrl: true,
        meta: false,
        shift: false,
        paste: false,
        sequence: '\x02',
      };
      // No-op: no throw.
      expect(() => handleKeypress!(ctrlBKey)).not.toThrow();
    });

    it('Ctrl+B does NOT promote when only a non-shell tool is executing (defense-in-depth)', () => {
      // Pin the per-tool-name guard: a non-shell executing tool that
      // somehow gained a `promoteAbortController` (copy-paste in a
      // future tool, type confusion) must NOT be promoted by Ctrl+B.
      // Without `tc.request.name === ToolNames.SHELL` in the find
      // predicate, the property check alone would mistakenly fire
      // abort({kind:'background'}) on a tool whose service has no
      // promote-handoff handler.
      const fakeNonShellAc = new AbortController();
      const abortSpy = vi.spyOn(fakeNonShellAc, 'abort');
      const executingNonShell = {
        status: 'executing',
        request: { callId: 'call-other-1', name: 'read_file' },
        // Hostile shape: non-shell tool carries the controller — must
        // be filtered out by the tool-name guard.
        promoteAbortController: fakeNonShellAc,
      };
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'responding',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        pendingToolCalls: [executingNonShell],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      const handleKeypress = mockedUseKeypress.mock.calls
        .map((call) => call[0])
        .reverse()
        .find(
          (handler): handler is (key: Key) => void =>
            typeof handler === 'function' &&
            handler.toString().includes('PROMOTE_SHELL_TO_BACKGROUND'),
        ) as ((key: Key) => void) | undefined;
      expect(handleKeypress).toBeDefined();

      const ctrlBKey: Key = {
        name: 'b',
        ctrl: true,
        meta: false,
        shift: false,
        paste: false,
        sequence: '\x02',
      };
      handleKeypress!(ctrlBKey);

      // The guard MUST suppress the abort even though the AC is
      // structurally present.
      expect(abortSpy).not.toHaveBeenCalled();
    });
  });

  describe('Thinking expansion (Ctrl+O) integration', () => {
    const makeKey = (overrides: Partial<Key>): Key =>
      ({
        name: '',
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: '',
        ...overrides,
      }) as Key;

    const ctrlO = makeKey({ name: 'o', ctrl: true, sequence: '\x0f' });

    it('Ctrl+O flips the full-detail state that expands thoughts and tool output', () => {
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        pendingToolCalls: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      const handleKeypress = getGlobalKeypress();
      expect(handleKeypress).toBeDefined();

      expect(capturedThoughtExpanded.allExpanded).toBe(false);

      // Behavioural: the handler must reach the Ctrl+O code path,
      // which calls refreshStatic → clearTerminal.
      mockStdout.write.mockClear();
      handleKeypress!(ctrlO);
      expect(mockStdout.write).toHaveBeenCalledWith(ansiEscapes.clearTerminal);

      // Structural (M1): the handler must contain the state flip.
      // Under this vi.mock('ink') harness the mocked App /
      // TestContextConsumer never re-renders when a handler extracted
      // from mockedUseKeypress.mock.calls calls setThoughtExpanded —
      // act(), async act(), setTimeout, and IS_REACT_ACT_ENVIRONMENT
      // were all tried; capturedThoughtExpanded.allExpanded stays
      // false.  MainContent.test.tsx ("fullDetail wiring") covers the
      // context → HistoryItemDisplay propagation behaviourally, so
      // this source-level guard closes the remaining gap: removing
      // or mutating setThoughtExpanded((prev) => !prev) in AppContainer
      // (e.g. (prev) => true) makes this assertion fail (mutation M1).
      expect(handleKeypress!.toString()).toMatch(
        /setThoughtExpanded\(\s*\(prev\)\s*=>\s*!prev/,
      );
    });
  });

  describe('Model Dialog Integration', () => {
    it('should provide isModelDialogOpen in the UIStateContext', () => {
      mockedUseModelCommand.mockReturnValue({
        isModelDialogOpen: true,
        openModelDialog: vi.fn(),
        closeModelDialog: vi.fn(),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(capturedUIState.isModelDialogOpen).toBe(true);
    });

    it('should provide model dialog actions in the UIActionsContext', () => {
      const mockCloseModelDialog = vi.fn();

      mockedUseModelCommand.mockReturnValue({
        isModelDialogOpen: false,
        openModelDialog: vi.fn(),
        closeModelDialog: mockCloseModelDialog,
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // Verify that the actions are correctly passed through context
      capturedUIActions.closeModelDialog();
      expect(mockCloseModelDialog).toHaveBeenCalled();
    });
  });

  // Coverage for the AppContainer onModelChange wiring. The Static header
  // (key = `${historyRemountKey}-${currentModel}`) and MainContent's
  // progressive-replay reset (keyed on historyRemountKey) both depend on
  // these two state updates landing in the same commit on a real model
  // change — see the comment in AppContainer.tsx around the
  // config.onModelChange subscription and PR #4119 review discussion.
  describe('Model change refreshStatic wiring', () => {
    function captureModelChangeListener(config: Config) {
      // Track every subscribe/unsubscribe pair. The CLI test harness
      // tears down ink's renderer after the initial render flush, which
      // runs the effect's cleanup synchronously — but the captured
      // callback closure is still callable (and AppContainer's setState
      // still updates state because React's update queue is independent
      // of the listener registration). We therefore fire on the LAST
      // captured callback, regardless of whether ink considers the
      // effect mounted, and assert on the number of subscribe/cleanup
      // calls separately for unsubscribe coverage.
      const subs: Array<{
        cb: (model: string) => void;
        active: boolean;
      }> = [];
      const fakeOnModelChange = vi.fn((cb: (model: string) => void) => {
        const entry = { cb, active: true };
        subs.push(entry);
        return () => {
          entry.active = false;
        };
      });
      (
        config as unknown as { onModelChange: typeof fakeOnModelChange }
      ).onModelChange = fakeOnModelChange;
      return {
        spy: fakeOnModelChange,
        notify: (model: string) => {
          if (subs.length === 0) {
            throw new Error('AppContainer never subscribed to onModelChange');
          }
          // Always fire on the most-recent captured callback.
          subs[subs.length - 1].cb(model);
        },
        subscribeCount: () => subs.length,
        activeCount: () => subs.filter((s) => s.active).length,
      };
    }

    // Effects run after the synchronous render returns. Flushing two
    // microtasks lines up the same pattern used by other async tests in
    // this file (search "Let the userMessages-fetching effect resolve").
    const flushEffects = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    it('fires refreshStatic in the same handler that updates currentModel', async () => {
      // Wenshao's PR #4119 [Critical]: if refreshStatic (which bumps
      // historyRemountKey) and setCurrentModel were split into two
      // separate effects, the first commit would show the new
      // currentModel against the OLD historyRemountKey — MainContent's
      // <Static key={`${historyRemountKey}-${currentModel}`}> would
      // remount BEFORE the progressive-replay reset, dumping the full
      // history in one frame.
      //
      // The fix moves refreshStatic into the event handler itself so
      // both side effects (clearTerminal + setHistoryRemountKey via
      // refreshStatic, plus setCurrentModel) run inside the same
      // synchronous JS task — React 18+ batches all setState calls in
      // an event-handler-style task into one commit. We verify this
      // synchronously by inspecting mockStdout.write the moment the
      // listener returns: clearTerminal must already be written, proving
      // refreshStatic runs in-handler rather than queued for a later
      // useEffect tick. (We cannot observe the post-commit React state
      // through capturedUIState here because ink-testing-library tears
      // down the renderer once render() returns, so setState calls
      // queued from the listener never produce a follow-up commit. The
      // synchronous side-effect ordering is the part that matters for
      // the bug wenshao flagged.)
      vi.spyOn(mockConfig, 'getModel').mockReturnValue('model-a');
      const trigger = captureModelChangeListener(mockConfig);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await flushEffects();
      mockStdout.write.mockClear();

      // Synchronous notification → refreshStatic must run BEFORE the
      // notify() call returns (i.e., before any React batch tick).
      trigger.notify('model-b');

      expect(mockStdout.write).toHaveBeenCalledWith(ansiEscapes.clearTerminal);
    });

    it('skips refreshStatic when the notified model matches the current one', async () => {
      vi.spyOn(mockConfig, 'getModel').mockReturnValue('model-a');
      const trigger = captureModelChangeListener(mockConfig);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await flushEffects();

      const baselineRemountKey = capturedUIState.historyRemountKey;
      mockStdout.write.mockClear();

      trigger.notify('model-a');
      await flushEffects();

      expect(mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      expect(capturedUIState.historyRemountKey).toBe(baselineRemountKey);
      expect(capturedUIState.currentModel).toBe('model-a');
    });

    it('fires refreshStatic only once per real model change (StrictMode-safe)', async () => {
      // StrictMode double-invokes state updater functions in dev. The
      // refreshStatic side-effect therefore must NOT live inside a
      // setState updater — it lives in the event handler, with a ref
      // guard to de-dupe redundant notifications. We simulate the
      // StrictMode-style re-fire by calling the listener twice with the
      // same value (e.g. if a deduplicator upstream missed it).
      vi.spyOn(mockConfig, 'getModel').mockReturnValue('model-a');
      const trigger = captureModelChangeListener(mockConfig);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await flushEffects();
      mockStdout.write.mockClear();

      trigger.notify('model-b');
      trigger.notify('model-b');
      await flushEffects();

      const clearWrites = mockStdout.write.mock.calls.filter(
        ([arg]) => arg === ansiEscapes.clearTerminal,
      );
      expect(clearWrites).toHaveLength(1);
    });

    it('returns an unsubscribe function that AppContainer wires up', async () => {
      // AppContainer's effect returns the unsubscribe so React can call it
      // on unmount or when deps change. We verify both halves of the
      // subscribe/cleanup contract were exercised — every subscribe must
      // have paired with a cleanup invocation by the time the renderer
      // tears down.
      vi.spyOn(mockConfig, 'getModel').mockReturnValue('model-a');
      const trigger = captureModelChangeListener(mockConfig);

      const { unmount } = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      await flushEffects();
      expect(trigger.subscribeCount()).toBeGreaterThanOrEqual(1);

      unmount();
      await flushEffects();

      expect(trigger.activeCount()).toBe(0);
    });
  });

  describe('handleRewindConfirm', () => {
    it('skips conversation truncation when both-mode file restore fails', async () => {
      const harness = renderRewindHarness({
        fileRewindResult: {
          filesChanged: [],
          filesFailed: ['src/bad.ts'],
        },
      });

      await runRewind(harness.target, 'both');

      expect(harness.rewind).toHaveBeenCalledWith('prompt-2', true);
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.setText).not.toHaveBeenCalled();
      expect(harness.rewindRecording).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Failed to restore 1 file(s): bad.ts',
        }),
        expect.any(Number),
      );
    });

    it('skips conversation truncation when both-mode file restore throws', async () => {
      const harness = renderRewindHarness({
        fileRewindError: new Error('snapshot missing'),
      });

      await runRewind(harness.target, 'both');

      expect(harness.rewind).toHaveBeenCalledWith('prompt-2', true);
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.setText).not.toHaveBeenCalled();
      expect(harness.rewindRecording).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Failed to restore files: snapshot missing',
        }),
        expect.any(Number),
      );
    });

    it('shows an error when restoring files without a prompt id', async () => {
      const harness = renderRewindHarness();

      await runRewind(rewindUserItem(3, 'second prompt'), 'code');

      expect(harness.rewind).not.toHaveBeenCalled();
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Cannot restore files: this turn was created before file checkpointing was enabled.',
        }),
        expect.any(Number),
      );
    });

    it('truncates conversation when both-mode file restore succeeds', async () => {
      const harness = renderRewindHarness();

      await runRewind(harness.target, 'both');

      expect(harness.rewind).toHaveBeenCalledWith('prompt-2', true);
      expect(harness.truncateHistory).toHaveBeenCalledWith(2);
      expect(harness.loadHistory).toHaveBeenCalledWith([
        rewindUserItem(1, 'first prompt', 'prompt-1'),
        { id: 2, type: 'gemini', text: 'first response' },
      ]);
      expect(mockClearPendingState).toHaveBeenCalledTimes(1);
      expect(mockClearPendingState.mock.invocationCallOrder[0]).toBeLessThan(
        harness.loadHistory.mock.invocationCallOrder[0]!,
      );
      expect(harness.setText).toHaveBeenCalledWith('second prompt');
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: 'Conversation rewound. Edit your prompt and press Enter to continue.',
        }),
        expect.any(Number),
      );
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: 'Restored 1 file(s).',
        }),
        expect.any(Number),
      );
      expect(harness.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 2 },
        harness.snapshots.slice(0, 2),
      );
    });

    it('re-arms the latch when rewinding past the context-file announcement', async () => {
      // Announcement sits after the rewind target, so it is filtered out of
      // truncatedUi; the latch re-arms and the next prompt re-announces the
      // still-attached files. We submit once before rewinding to consume
      // the latch, so the re-arm transition is actually exercised.
      const history: HistoryItem[] = [
        rewindUserItem(1, 'first prompt', 'prompt-1'),
        { id: 2, type: 'gemini', text: 'first response' },
        rewindUserItem(3, 'second prompt', 'prompt-2'),
        {
          id: 4,
          type: MessageType.INFO,
          text: `${CONTEXT_FILES_ANNOUNCEMENT_PREFIX} QWEN.md`,
        },
      ];
      const harness = renderRewindHarness({
        history,
        contextFilePaths: ['QWEN.md'],
      });

      // Consume the latch so the rewind's re-arm is a real transition.
      capturedUIActions.handleFinalSubmit('first', {
        submittedPrompt: 'first',
      });
      const announcementsBefore = harness.addItem.mock.calls.filter(([item]) =>
        isContextFilesAnnouncement(item),
      );
      expect(announcementsBefore).toHaveLength(1);

      await runRewind(harness.target, 'both');

      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      const announcementsAfter = harness.addItem.mock.calls.filter(([item]) =>
        isContextFilesAnnouncement(item),
      );
      expect(announcementsAfter).toHaveLength(2);
    });

    it('keeps the latch consumed when rewinding to a turn after the announcement', async () => {
      // Announcement sits before the rewind target, so it survives in
      // truncatedUi; the latch stays consumed and the next prompt does not
      // duplicate the announcement.
      const history: HistoryItem[] = [
        rewindUserItem(1, 'first prompt', 'prompt-1'),
        {
          id: 2,
          type: MessageType.INFO,
          text: `${CONTEXT_FILES_ANNOUNCEMENT_PREFIX} QWEN.md`,
        },
        rewindUserItem(3, 'second prompt', 'prompt-2'),
        { id: 4, type: 'gemini', text: 'second response' },
      ];
      const harness = renderRewindHarness({
        history,
        contextFilePaths: ['QWEN.md'],
      });

      await runRewind(harness.target, 'both');

      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      const announcements = harness.addItem.mock.calls.filter(([item]) =>
        isContextFilesAnnouncement(item),
      );
      expect(announcements).toHaveLength(0);
    });

    it('restores code only without truncating conversation history', async () => {
      const harness = renderRewindHarness();

      await runRewind(harness.target, 'code');

      expect(harness.rewind).toHaveBeenCalledWith('prompt-2', false);
      expect(harness.getHistoryShallow).not.toHaveBeenCalled();
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.setText).not.toHaveBeenCalled();
      expect(harness.rewindRecording).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: 'Restored 1 file(s).',
        }),
        expect.any(Number),
      );
    });

    it('rewinds conversation only without restoring files', async () => {
      const harness = renderRewindHarness();

      await runRewind(harness.target, 'conversation');

      expect(harness.rewind).not.toHaveBeenCalled();
      expect(harness.truncateHistory).toHaveBeenCalledWith(2);
      expect(harness.loadHistory).toHaveBeenCalledWith([
        rewindUserItem(1, 'first prompt', 'prompt-1'),
        { id: 2, type: 'gemini', text: 'first response' },
      ]);
      expect(harness.setText).toHaveBeenCalledWith('second prompt');
      expect(harness.rewindRecording).toHaveBeenCalledWith(
        1,
        { truncatedCount: 2 },
        harness.snapshots.slice(0, 2),
      );

      capturedUIActions.handleFinalSubmit('second prompt', {
        submittedPrompt: 'second prompt',
      });
      expect(harness.addMessage).toHaveBeenCalledWith(
        'second prompt',
        false,
        undefined,
      );
      expect(harness.setText).toHaveBeenLastCalledWith('', {
        clearUndoHistory: true,
      });
    });

    it('shows an error and returns for conversation-only rewind with no client', async () => {
      const harness = renderRewindHarness({ noGeminiClient: true });

      await runRewind(harness.target, 'conversation');

      expect(harness.rewind).not.toHaveBeenCalled();
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Cannot rewind conversation: no active model client.',
        }),
        expect.any(Number),
      );
    });

    it('falls back to code restore for both-mode rewind with no client', async () => {
      const harness = renderRewindHarness({ noGeminiClient: true });

      await runRewind(harness.target, 'both');

      expect(harness.rewind).toHaveBeenCalledWith('prompt-2', false);
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: 'Code restored, but conversation could not be rewound (no active client).',
        }),
        expect.any(Number),
      );
    });

    it('surfaces unexpected outer errors through history', async () => {
      const harness = renderRewindHarness();
      vi.spyOn(mockConfig, 'getGeminiClient').mockImplementation(() => {
        throw new Error('client exploded');
      });

      await runRewind(harness.target, 'conversation');

      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Rewind failed: client exploded',
        }),
        expect.any(Number),
      );
      expect(harness.rewind).not.toHaveBeenCalled();
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
    });

    it('bails before file restore when the target turn is compressed', async () => {
      const harness = renderRewindHarness({
        apiHistory: [apiUser('first prompt'), apiModel('first response')],
      });

      await runRewind(harness.target, 'both');

      expect(harness.rewind).not.toHaveBeenCalled();
      expect(harness.truncateHistory).not.toHaveBeenCalled();
      expect(harness.loadHistory).not.toHaveBeenCalled();
      expect(harness.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          text: 'Cannot rewind to a turn that was compressed. Try a more recent turn.',
        }),
        expect.any(Number),
      );
    });
  });

  describe('IDE mode rewind guard', () => {
    it('shows info message instead of opening rewind selector when IDE mode is enabled', () => {
      const mockAddItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'hello' }],
        addItem: mockAddItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: vi.fn(),
      });
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      vi.spyOn(mockConfig, 'getIdeMode').mockReturnValue(true);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.openRewindSelector();

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'info',
          text: expect.stringMatching(/rewind.*disabled.*IDE/i),
        }),
        expect.any(Number),
      );
      expect(capturedUIState.isRewindSelectorOpen).toBeFalsy();
    });

    it('opens rewind selector normally when IDE mode is disabled', () => {
      const mockAddItemDisabled = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [{ id: 1, type: 'user', text: 'hello' }],
        addItem: mockAddItemDisabled,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
        truncateToItem: vi.fn(),
      });
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
        streamingResponseLengthRef: { current: 0 },
        isReceivingContent: false,
      });
      vi.spyOn(mockConfig, 'getIdeMode').mockReturnValue(false);

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.openRewindSelector();

      expect(mockAddItemDisabled).not.toHaveBeenCalled();
    });
  });

  describe('Skill review auto-open gating (shouldAutoOpenSkillReview)', () => {
    const pending = {
      taskId: 'skill-task-1',
      skills: [
        {
          name: 'auto-skill-alpha',
          description: 'does alpha',
          stagedManifestPath: '/tmp/staged/auto-skill-alpha/SKILL.md',
        },
      ],
    };

    /** The baseline where every gate is satisfied and the dialog opens. */
    const openable = {
      pending,
      streamingState: StreamingState.Idle,
      isMemoryDialogOpen: false,
      autoSkillEnabled: true,
      dismissedTaskIds: new Set<string>(),
    };

    it('opens when idle with an undismissed pending batch and auto-skill on', () => {
      expect(shouldAutoOpenSkillReview(openable)).toBe(true);
    });

    it('does NOT open while auto-skill is disabled (the turn-off flow)', () => {
      // The state right after "Turn off auto-generated skills": the batch
      // stays pending (turn-off closes without dismissing), so only the live
      // flag keeps it from re-popping.
      expect(
        shouldAutoOpenSkillReview({ ...openable, autoSkillEnabled: false }),
      ).toBe(false);
    });

    it('does NOT open over an open /memory dialog', () => {
      expect(
        shouldAutoOpenSkillReview({ ...openable, isMemoryDialogOpen: true }),
      ).toBe(false);
    });

    it('opens again once /memory closes with auto-skill re-enabled', () => {
      // The re-enable flow: same inputs as the case above except /memory has
      // been closed (the effect re-runs on isMemoryDialogOpen for exactly
      // this transition), so the pending batch resurfaces.
      expect(
        shouldAutoOpenSkillReview({ ...openable, isMemoryDialogOpen: false }),
      ).toBe(true);
    });

    it('does NOT reopen a batch the user dismissed with Esc', () => {
      expect(
        shouldAutoOpenSkillReview({
          ...openable,
          dismissedTaskIds: new Set([pending.taskId]),
        }),
      ).toBe(false);
    });

    it('does NOT open while streaming or with no pending skills', () => {
      expect(
        shouldAutoOpenSkillReview({
          ...openable,
          streamingState: StreamingState.Responding,
        }),
      ).toBe(false);
      expect(shouldAutoOpenSkillReview({ ...openable, pending: null })).toBe(
        false,
      );
      expect(
        shouldAutoOpenSkillReview({
          ...openable,
          pending: { taskId: 'skill-task-1', skills: [] },
        }),
      ).toBe(false);
    });
  });

  describe('context files announcement (#5267)', () => {
    const renderAnnouncementHarness = (contextFilePaths: string[]) => {
      const addItem = vi.fn();
      const loadHistory = vi.fn();
      const enqueueMessage = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory,
        truncateToItem: vi.fn(),
      });
      mockedUseMessageQueue.mockReturnValue({
        removeGoalTurns: vi.fn().mockReturnValue([]),
        messageQueue: [],
        addMessage: enqueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextTurn: vi.fn().mockReturnValue(null),
      });
      vi.spyOn(mockConfig, 'getContextFilePaths').mockReturnValue(
        contextFilePaths,
      );
      const view = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      return { addItem, enqueueMessage, loadHistory, view };
    };

    const announcementCalls = (addItem: ReturnType<typeof vi.fn>) =>
      addItem.mock.calls.filter(([item]) => isContextFilesAnnouncement(item));

    it('announces loaded context files above the first real prompt, once', () => {
      const { addItem, enqueueMessage } = renderAnnouncementHarness([
        'QWEN.md',
        '~/.qwen/QWEN.md',
      ]);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
      expect(addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: `${CONTEXT_FILES_ANNOUNCEMENT_PREFIX} QWEN.md, ~/.qwen/QWEN.md`,
        }),
        expect.any(Number),
      );
      // The INFO item must be added before the submission is admitted, so it
      // renders above the prompt.
      expect(enqueueMessage).toHaveBeenCalled();
      const announcementIndex = addItem.mock.calls.findIndex(([item]) =>
        isContextFilesAnnouncement(item),
      );
      expect(addItem.mock.invocationCallOrder[announcementIndex]).toBeLessThan(
        enqueueMessage.mock.invocationCallOrder[0],
      );

      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('does not consume the latch on a leading slash command', () => {
      const { addItem } = renderAnnouncementHarness(['QWEN.md']);

      capturedUIActions.handleFinalSubmit('/help', {
        submittedPrompt: '/help',
      });
      expect(announcementCalls(addItem)).toHaveLength(0);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('does not consume the latch on a leading /btw command', () => {
      const { addItem } = renderAnnouncementHarness(['QWEN.md']);

      capturedUIActions.handleFinalSubmit('/btw side note', {
        submittedPrompt: '/btw side note',
      });
      expect(announcementCalls(addItem)).toHaveLength(0);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('emits nothing when no context files are loaded, and re-arms for files attached later', () => {
      const { addItem } = renderAnnouncementHarness([]);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(0);

      // Files attached later in the session (e.g. /directory add) must still
      // get their one-shot notice: the latch is only consumed when something
      // was actually announced.
      vi.mocked(mockConfig.getContextFilePaths).mockReturnValue(['QWEN.md']);
      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('re-arms the latch after Ctrl-L (handleClearScreen) wipes the INFO', () => {
      const { addItem } = renderAnnouncementHarness(['QWEN.md']);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);

      // Ctrl-L wipes the emitted INFO without a session switch; the latch
      // must re-arm so the still-attached files re-announce on the next
      // prompt.
      capturedUIActions.handleClearScreen();

      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      expect(announcementCalls(addItem)).toHaveLength(2);
    });

    it('re-arms the latch when sessionStats.sessionId changes (startNewSession)', () => {
      // Scoped stub: React's double-mount re-runs the mount init effect and
      // the second initialize() throws inside an un-awaited IIFE, surfacing
      // as an unhandled rejection when this test runs in isolation (-t
      // filtered, watch mode, or sharded runs exit 1 because of it).
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);

      mockedUseSessionStats.mockReturnValue({
        stats: { sessionId: 'session-a' },
        seedPromptCount: vi.fn(),
      });
      const { addItem, view } = renderAnnouncementHarness(['QWEN.md']);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);

      // /clear flows through SessionContext.startNewSession, which swaps
      // the session id. The effect must re-arm the latch so the new
      // session's first prompt re-announces the still-attached files.
      mockedUseSessionStats.mockReturnValue({
        stats: { sessionId: 'session-b' },
        seedPromptCount: vi.fn(),
      });
      act(() => {
        view.rerender(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
      });

      capturedUIActions.handleFinalSubmit('again', {
        submittedPrompt: 'again',
      });
      expect(announcementCalls(addItem)).toHaveLength(2);
    });

    it('arms the latch after a startup --resume restore (announcement is UI-only)', async () => {
      vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
      vi.spyOn(mockConfig, 'getResumedSessionData').mockReturnValue({
        conversation: {
          sessionId: 'session-1',
          projectHash: 'test-project-hash',
          startTime: '2024-01-01T00:00:00Z',
          lastUpdated: '2024-01-01T00:00:01Z',
          messages: [
            {
              uuid: 'u1',
              parentUuid: null,
              sessionId: 'session-1',
              timestamp: '2024-01-01T00:00:00Z',
              type: 'user',
              message: { role: 'user', parts: [{ text: 'hello' }] },
              cwd: '/test/workspace',
              version: '1.0.0',
            },
          ],
        },
        filePath: '/tmp/session.jsonl',
        lastCompletedUuid: 'u1',
      } as ReturnType<typeof mockConfig.getResumedSessionData>);
      vi.spyOn(mockConfig, 'loadPausedBackgroundAgents').mockResolvedValue([]);
      const { addItem, loadHistory } = renderAnnouncementHarness(['QWEN.md']);

      // The startup resume path must route through the reconciling
      // wrapper: the rebuilt history has no announcement (the INFO is
      // UI-only and never persisted), so the latch stays armed and the
      // next prompt announces.
      await vi.waitFor(() => {
        expect(loadHistory).toHaveBeenCalled();
      });

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('does not consume the latch on a whitespace-only prompt', () => {
      const { addItem } = renderAnnouncementHarness(['QWEN.md']);

      // Blank submissions are dropped downstream and never reach the model.
      capturedUIActions.handleFinalSubmit('   ', {
        submittedPrompt: '   ',
      });
      expect(announcementCalls(addItem)).toHaveLength(0);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('consumes the latch on a model-invocable slash command (skills)', () => {
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: vi.fn(),
        slashCommands: [
          {
            name: 'feat-dev',
            description: 'Feature development workflow',
            kind: CommandKind.SKILL,
            modelInvocable: true,
            action: vi.fn(),
          },
        ],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      const { addItem } = renderAnnouncementHarness(['QWEN.md']);

      // Skills are expanded into a submit_prompt that reaches the model, so
      // the announcement must attach to this turn, not a later plain prompt.
      capturedUIActions.handleFinalSubmit('/feat-dev implement X', {
        submittedPrompt: '/feat-dev implement X',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);

      capturedUIActions.handleFinalSubmit('hello', {
        submittedPrompt: 'hello',
      });
      expect(announcementCalls(addItem)).toHaveLength(1);
    });

    it('performMemoryRefresh anchors on config.getWorkingDir() and updates contextFilePaths', async () => {
      mockLoadHierarchicalGeminiMemory.mockResolvedValue({
        memoryContent: 'content',
        fileCount: 1,
        contextFilePaths: ['/custom/QWEN.md'],
        conditionalRules: [],
        projectRoot: '/custom',
      });
      vi.spyOn(mockConfig, 'getWorkingDir').mockReturnValue(
        '/custom/workspace',
      );
      vi.spyOn(mockConfig, 'isSafeMode').mockReturnValue(false);
      // Pin distinct sentinels for same-typed slots 4 and 7 so a
      // positional swap is caught.
      vi.spyOn(mockConfig, 'getExtensionContextFilePaths').mockReturnValue([
        'ext-context.md',
      ]);
      vi.spyOn(mockConfig, 'getContextRuleExcludes').mockReturnValue([
        'exclude-rule',
      ]);
      const setContextFilePathsSpy = vi.spyOn(
        mockConfig,
        'setContextFilePaths',
      );

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      // performMemoryRefresh is the 12th arg (index 11) passed to
      // useGeminiStream by AppContainer.
      const calls = mockedUseGeminiStream.mock.calls;
      const performMemoryRefresh = calls[
        calls.length - 1
      ]![11] as () => Promise<void>;
      expect(typeof performMemoryRefresh).toBe('function');

      await act(async () => {
        await performMemoryRefresh();
      });

      expect(mockLoadHierarchicalGeminiMemory).toHaveBeenCalledWith(
        '/custom/workspace',
        expect.anything(),
        expect.anything(),
        ['ext-context.md'],
        true,
        expect.anything(),
        ['exclude-rule'],
        expect.anything(),
      );
      expect(setContextFilePathsSpy).toHaveBeenCalledWith(['/custom/QWEN.md']);
    });
  });
});

describe('dedupeNewestFirst', () => {
  it('returns empty array for empty input', () => {
    expect(dedupeNewestFirst([])).toEqual([]);
  });

  it('preserves order when there are no duplicates', () => {
    expect(dedupeNewestFirst(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('removes consecutive duplicates', () => {
    expect(dedupeNewestFirst(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('removes non-consecutive duplicates keeping the first (newest) occurrence', () => {
    expect(
      dedupeNewestFirst([
        'first prompt',
        'third prompt',
        'second prompt',
        'first prompt',
      ]),
    ).toEqual(['first prompt', 'third prompt', 'second prompt']);
  });
});

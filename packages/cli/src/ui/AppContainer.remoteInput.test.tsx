/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
import { Box } from 'ink';

// ink-testing-library uses Ink's custom React reconciler which does not
// flush useEffect synchronously after render(). Mocked hook values are set
// before render, but effects that wire remoteInput / dualOutput callbacks
// fire asynchronously and cannot be reliably awaited in this environment.
// The integration is verified indirectly through unit tests on
// RemoteInputWatcher and DualOutputBridge, and through E2E tests.
// Ref: SettingsDialog test pattern uses act() wrapping user interactions,
// not initial mount effects, which is the pattern supported by ink.
import { AppContainer } from './AppContainer.js';
import {
  type Config,
  makeFakeConfig,
  type GeminiClient,
  type SubagentManager,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { InitializationResult } from '../core/initializer.js';

let mockStdout: { write: ReturnType<typeof vi.fn> };
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: mockStdout }),
    measureElement: vi.fn(),
  };
});

vi.mock('./App.js', () => ({
  App: () => <Box />,
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
vi.mock('./contexts/VimModeContext.js');
vi.mock('./contexts/SessionContext.js');
vi.mock('./contexts/AgentViewContext.js', () => ({
  useAgentViewState: vi.fn(() => ({
    activeView: 'main',
    agents: new Map(),
  })),
  useAgentViewActions: vi.fn(() => ({
    switchToMain: vi.fn(),
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
vi.mock('../remoteInput/RemoteInputContext.js', () => ({
  useRemoteInput: vi.fn(),
}));
vi.mock('../dualOutput/DualOutputContext.js', () => ({
  useDualOutput: vi.fn(),
}));
vi.mock('../utils/events.js');
vi.mock('../utils/handleAutoUpdate.js');
vi.mock('../utils/cleanup.js');

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
import { useVimMode } from './contexts/VimModeContext.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useRemoteInput } from '../remoteInput/RemoteInputContext.js';
import { useDualOutput } from '../dualOutput/DualOutputContext.js';

describe('AppContainer remote input and dual output integration', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockInitResult: InitializationResult;

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
  const mockedUseVimMode = useVimMode as Mock;
  const mockedUseSessionStats = useSessionStats as Mock;
  const mockedUseTextBuffer = useTextBuffer as Mock;
  const mockedUseLogger = useLogger as Mock;
  const mockedUseLoadingIndicator = useLoadingIndicator as Mock;
  const mockedUseRemoteInput = useRemoteInput as Mock;
  const mockedUseDualOutput = useDualOutput as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStdout = { write: vi.fn() };

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
      state: {
        authState: 'authenticated',
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
      actions: {
        setAuthState: vi.fn(),
        onAuthError: vi.fn(),
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
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
      handleApprovalModeChange: vi.fn(),
      activePtyId: undefined,
      loopDetectionConfirmationRequest: null,
      pendingToolCalls: [],
      streamingResponseLengthRef: { current: 0 },
      isReceivingContent: false,
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
      messageQueue: [],
      addMessage: vi.fn(),
      clearQueue: vi.fn(),
      getQueuedMessagesText: vi.fn().mockReturnValue(''),
      popAllMessages: vi.fn().mockReturnValue(null),
      drainQueue: vi.fn().mockReturnValue([]),
      popNextSegment: vi.fn().mockReturnValue(null),
    });
    mockedUseAutoAcceptIndicator.mockReturnValue(false);
    mockedUseGitBranchName.mockReturnValue('main');
    mockedUseVimMode.mockReturnValue({
      isVimEnabled: false,
      toggleVimEnabled: vi.fn(),
    });
    mockedUseSessionStats.mockReturnValue({
      stats: {},
      startNewSession: vi.fn(),
    });
    mockedUseTextBuffer.mockReturnValue({
      text: '',
      setText: vi.fn(),
    });
    mockedUseLogger.mockReturnValue({
      getPreviousUserMessages: vi.fn().mockResolvedValue([]),
    });
    mockedUseLoadingIndicator.mockReturnValue({
      elapsedTime: '0.0s',
      currentLoadingPhrase: '',
    });
    mockedUseRemoteInput.mockReturnValue(null);
    mockedUseDualOutput.mockReturnValue(null);

    mockConfig = makeFakeConfig();
    vi.spyOn(mockConfig, 'getTargetDir').mockReturnValue('/test/workspace');

    const mockGeminiClient: Partial<GeminiClient> = {
      initialize: vi.fn().mockResolvedValue(undefined),
      setTools: vi.fn().mockResolvedValue(undefined),
      isInitialized: vi.fn().mockReturnValue(false),
    };
    vi.spyOn(mockConfig, 'getGeminiClient').mockReturnValue(
      mockGeminiClient as GeminiClient,
    );

    const mockSubagentManager: Partial<SubagentManager> = {
      listSubagents: vi.fn().mockResolvedValue([]),
      addChangeListener: vi.fn(),
      loadSubagent: vi.fn(),
      createSubagent: vi.fn(),
    };
    vi.spyOn(mockConfig, 'getSubagentManager').mockReturnValue(
      mockSubagentManager as SubagentManager,
    );

    mockSettings = {
      merged: {
        hideTips: false,
        theme: 'default',
        ui: {
          showStatusInTitle: false,
          hideWindowTitle: false,
        },
      },
    } as unknown as LoadedSettings;

    mockInitResult = {
      themeError: null,
      authError: null,
      shouldOpenAuthDialog: false,
      geminiMdFileCount: 0,
    } as InitializationResult;
  });

  afterEach(() => {
    cleanup();
  });

  // Skipped: ink-testing-library does not flush useEffect after initial
  // render. These integration paths are covered by RemoteInputWatcher and
  // DualOutputBridge unit tests.
  it.skip('wires remote input watcher to submitQuery and idle notifications', () => {
    const mockSubmitQuery = vi.fn();
    const remoteInput = {
      setSubmitFn: vi.fn(),
      notifyIdle: vi.fn(),
      setConfirmationHandler: vi.fn(),
    };

    mockedUseGeminiStream.mockReturnValue({
      streamingState: 'idle',
      submitQuery: mockSubmitQuery,
      initError: null,
      pendingHistoryItems: [],
      thought: null,
      cancelOngoingRequest: vi.fn(),
      retryLastPrompt: vi.fn(),
      handleApprovalModeChange: vi.fn(),
      activePtyId: undefined,
      loopDetectionConfirmationRequest: null,
      pendingToolCalls: [],
      streamingResponseLengthRef: { current: 0 },
      isReceivingContent: false,
    });
    mockedUseRemoteInput.mockReturnValue(remoteInput);

    render(
      <AppContainer
        config={mockConfig}
        settings={mockSettings}
        version="1.0.0"
        initializationResult={mockInitResult}
      />,
    );

    expect(remoteInput.setSubmitFn).toHaveBeenCalledTimes(1);
    expect(remoteInput.notifyIdle).toHaveBeenCalledTimes(1);
    expect(remoteInput.setSubmitFn).toHaveBeenCalledWith(expect.any(Function));
  });

  // Skipped: ink-testing-library does not flush useEffect after initial
  // render. These integration paths are covered by RemoteInputWatcher and
  // DualOutputBridge unit tests.
  it.skip('bridges pending tool confirmations to dual output and remote input', () => {
    const onConfirm = vi.fn();
    const remoteInput = {
      setSubmitFn: vi.fn(),
      notifyIdle: vi.fn(),
      setConfirmationHandler: vi.fn(),
    };
    const dualOutput = {
      isConnected: true,
      emitPermissionRequest: vi.fn(),
      emitControlResponse: vi.fn(),
    };

    mockedUseGeminiStream.mockReturnValue({
      streamingState: 'waiting_for_confirmation',
      submitQuery: vi.fn(),
      initError: null,
      pendingHistoryItems: [],
      thought: null,
      cancelOngoingRequest: vi.fn(),
      retryLastPrompt: vi.fn(),
      handleApprovalModeChange: vi.fn(),
      activePtyId: undefined,
      loopDetectionConfirmationRequest: null,
      pendingToolCalls: [
        {
          status: 'awaiting_approval',
          request: {
            callId: 'call-1',
            name: 'shell',
            args: { cmd: 'ls' },
          },
          confirmationDetails: { onConfirm },
        },
      ],
      streamingResponseLengthRef: { current: 0 },
      isReceivingContent: false,
    });
    mockedUseRemoteInput.mockReturnValue(remoteInput);
    mockedUseDualOutput.mockReturnValue(dualOutput);
    mockedUseSessionStats.mockReturnValue({
      stats: { sessionId: 'session-123' },
      startNewSession: vi.fn(),
    });

    render(
      <AppContainer
        config={mockConfig}
        settings={mockSettings}
        version="1.0.0"
        initializationResult={mockInitResult}
      />,
    );

    expect(dualOutput.emitPermissionRequest).toHaveBeenCalledTimes(1);
    expect(remoteInput.setConfirmationHandler).toHaveBeenCalledWith(
      expect.any(Function),
    );
  });
});

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
import {
  AppContainer,
  dedupeNewestFirst,
  getNextRenderMode,
  isRenderModeToggleKey,
} from './AppContainer.js';
import ansiEscapes from 'ansi-escapes';
import {
  type Config,
  makeFakeConfig,
  type GeminiClient,
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
import { type HistoryItem, ToolCallStatus } from './types.js';
import { useContext } from 'react';
import { Box, measureElement } from 'ink';

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
function TestContextConsumer() {
  capturedUIState = useContext(UIStateContext)!;
  capturedUIActions = useContext(UIActionsContext)!;
  capturedRenderMode = useRenderMode().renderMode;
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

// Mock external utilities
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
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useKeypress, type Key } from './hooks/useKeypress.js';
import { ShellExecutionService } from '@qwen-code/qwen-code-core';

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
  const mockedUseVimMode = useVimMode as Mock;
  const mockedUseSessionStats = useSessionStats as Mock;
  const mockedUseTextBuffer = useTextBuffer as Mock;
  const mockedUseLogger = useLogger as Mock;
  const mockedUseLoadingIndicator = useLoadingIndicator as Mock;
  const mockedUseTerminalSize = useTerminalSize as Mock;
  const mockedUseKeypress = useKeypress as Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Initialize mock stdout for terminal title tests
    mockStdout = { write: vi.fn() };

    // Mock computeWindowTitle function to centralize title logic testing
    vi.mock('../utils/windowTitle.js', async () => ({
      computeWindowTitle: vi.fn(
        (folderName: string) =>
          // Default behavior: return "Gemini - {folderName}" unless CLI_TITLE is set
          process.env['CLI_TITLE'] || `Gemini - ${folderName}`,
      ),
    }));

    capturedUIState = null!;
    capturedUIActions = null!;
    capturedRenderMode = 'render';

    // **Provide a default return value for EVERY mocked hook.**
    mockedUseHistory.mockReturnValue({
      history: [],
      addItem: vi.fn(),
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
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
      handleAuthSelect: vi.fn(),
      handleSubscriptionPlanSubmit: vi.fn(),
      handleCodingPlanSubmit: vi.fn(),
      handleTokenPlanSubmit: vi.fn(),
      handleApiKeyProviderSubmit: vi.fn(),
      handleOpenRouterSubmit: vi.fn(),
      handleCustomApiKeySubmit: vi.fn(),
      openAuthDialog: vi.fn(),
      cancelAuthentication: vi.fn(),
      actions: {
        setAuthState: vi.fn(),
        onAuthError: vi.fn(),
        handleAuthSelect: vi.fn(),
        handleProviderSubmit: vi.fn(),
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
    mockedUseSessionStats.mockReturnValue({ stats: {} });
    mockedUseTextBuffer.mockReturnValue({
      text: '',
      setText: vi.fn(),
      // Add other properties if AppContainer uses them
    });
    mockedUseLogger.mockReturnValue({
      getPreviousUserMessages: vi.fn().mockResolvedValue([]),
    });
    mockedUseLoadingIndicator.mockReturnValue({
      elapsedTime: '0.0s',
      currentLoadingPhrase: '',
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

    // Mock SubagentManager to prevent errors during AgentTool initialization
    const mockSubagentManager: Partial<SubagentManager> = {
      listSubagents: vi.fn().mockResolvedValue([]),
      addChangeListener: vi.fn(),
      loadSubagent: vi.fn(),
      createSubagent: vi.fn(),
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

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
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

    it('does not clear the terminal just because width changed', () => {
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

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
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
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextSegment: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('/btw quick side question');

      expect(mockSubmitQuery).toHaveBeenCalledWith('/btw quick side question');
      expect(mockQueueMessage).not.toHaveBeenCalled();
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
      });
      mockedUseMessageQueue.mockReturnValue({
        messageQueue: [],
        addMessage: mockQueueMessage,
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextSegment: vi.fn().mockReturnValue(null),
      });

      render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      capturedUIActions.handleFinalSubmit('/model');

      expect(mockSubmitQuery).toHaveBeenCalledWith('/model');
      expect(mockQueueMessage).not.toHaveBeenCalled();
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
          messageQueue: [],
          addMessage: mockQueueMessage,
          clearQueue: vi.fn(),
          getQueuedMessagesText: vi.fn().mockReturnValue(''),
          popAllMessages: vi.fn().mockReturnValue(null),
          drainQueue: vi.fn().mockReturnValue([]),
          popNextSegment: vi.fn().mockReturnValue(null),
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
    // arg (positional index 14 — see the useGeminiStream call site in
    // AppContainer.tsx). We capture it via mockImplementation so a future
    // signature change surfaces as a clear test failure rather than silently
    // grabbing the wrong callback.
    const ON_CANCEL_SUBMIT_ARG_INDEX = 14;
    let capturedOnCancelSubmit: (() => void) | null = null;

    const installCancelCapture = (
      streamReturnValue: Record<string, unknown>,
    ) => {
      capturedOnCancelSubmit = null;
      mockedUseGeminiStream.mockImplementation((...args: unknown[]) => {
        const candidate = args[ON_CANCEL_SUBMIT_ARG_INDEX];
        if (typeof candidate === 'function') {
          capturedOnCancelSubmit = candidate as () => void;
        }
        return streamReturnValue;
      });
    };

    const triggerCancel = () => {
      if (!capturedOnCancelSubmit) {
        throw new Error(
          `onCancelSubmit was not captured at arg index ${ON_CANCEL_SUBMIT_ARG_INDEX} — useGeminiStream signature may have changed`,
        );
      }
      capturedOnCancelSubmit();
    };

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
        messageQueue: [],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue(''),
        popAllMessages: vi.fn().mockReturnValue(null),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextSegment: vi.fn().mockReturnValue(null),
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
      const mockPopAllMessages = vi.fn().mockReturnValue('queued follow-up');
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
        messageQueue: ['queued follow-up'],
        addMessage: vi.fn(),
        clearQueue: mockClearQueue,
        getQueuedMessagesText: vi.fn().mockReturnValue('queued follow-up'),
        popAllMessages: mockPopAllMessages,
        drainQueue: vi.fn().mockReturnValue(['queued follow-up']),
        popNextSegment: vi.fn().mockReturnValue('queued follow-up'),
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

    it('drops the queue when cancelling during tool execution', async () => {
      // Simulates: user asks for a shell tool (e.g. sleep 30), queues
      // `/model` and `hi` while the tool is running, then hits Ctrl+C.
      // The cancel must clear BOTH the buffer and the queue so that
      // `hi` does not auto-fire once the tool settles and the app
      // returns to idle.
      const mockSetText = vi.fn();
      const mockClearQueue = vi.fn();
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
        messageQueue: ['/model', 'hi'],
        addMessage: vi.fn(),
        clearQueue: mockClearQueue,
        getQueuedMessagesText: vi.fn().mockReturnValue('/model\n\nhi'),
        popAllMessages: vi.fn().mockReturnValue('/model'),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextSegment: vi.fn().mockReturnValue('/model'),
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

      // Buffer cleared and queue dropped — same "abort and redirect"
      // contract as the non-tool cancel path.
      expect(mockSetText).toHaveBeenCalledWith('');
      expect(mockClearQueue).toHaveBeenCalled();
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
        messageQueue: ['queued follow-up'],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue('queued follow-up'),
        popAllMessages: vi.fn().mockReturnValue('queued follow-up'),
        drainQueue: vi.fn().mockReturnValue(['queued follow-up']),
        popNextSegment: vi.fn().mockReturnValue('queued follow-up'),
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
    beforeEach(() => {
      // Reset mock stdout for each test
      mockStdout = { write: vi.fn() };
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
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
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
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(0);
      unmount();
    });

    it('should update terminal title with thought subject when in active state', () => {
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

      // Assert: Check that title was updated with thought subject
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]2;${thoughtSubject.padEnd(80, ' ')}\x07`,
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

      // Assert: Check that title was updated with default Idle text
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]2;${'Gemini - workspace'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    it('should update terminal title when in WaitingForConfirmation state with thought subject', () => {
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
        streamingState: 'waitingForConfirmation',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: { subject: thoughtSubject },
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
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

      // Assert: Check that title was updated with confirmation text
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]2;${thoughtSubject.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    it('should pad title to exactly 80 characters', () => {
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
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      const calledWith = titleWrites[0][0];
      const expectedTitle = shortTitle.padEnd(80, ' ');

      expect(calledWith).toContain(shortTitle);
      expect(calledWith).toContain('\x1b]2;');
      expect(calledWith).toContain('\x07');
      expect(calledWith).toBe('\x1b]2;' + expectedTitle + '\x07');
      unmount();
    });

    it('should use correct ANSI escape code format', () => {
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
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      const expectedEscapeSequence = `\x1b]2;${title.padEnd(80, ' ')}\x07`;
      expect(titleWrites[0][0]).toBe(expectedEscapeSequence);
      unmount();
    });

    it('should use CLI_TITLE environment variable when set', () => {
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
      vi.stubEnv('CLI_TITLE', 'Custom Gemini Title');

      // Mock the streaming state as Idle with no thought
      mockedUseGeminiStream.mockReturnValue({
        streamingState: 'idle',
        submitQuery: vi.fn(),
        initError: null,
        pendingHistoryItems: [],
        thought: null,
        cancelOngoingRequest: vi.fn(),
        retryLastPrompt: vi.fn(),
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

      // Assert: Check that title was updated with CLI_TITLE value
      const titleWrites = mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]2;'),
      );
      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]2;${'Custom Gemini Title'.padEnd(80, ' ')}\x07`,
      );
      unmount();
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

    it('does not remeasure footer height for sticky todo status-only updates', () => {
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

      const view = render(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );
      const callsAfterInitialRender = mockedMeasureElement.mock.calls.length;

      historyManager.history = makeTodoHistory('in_progress');
      view.rerender(
        <AppContainer
          config={mockConfig}
          settings={mockSettings}
          version="1.0.0"
          initializationResult={mockInitResult}
        />,
      );

      expect(mockedMeasureElement).toHaveBeenCalledTimes(
        callsAfterInitialRender,
      );
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
        handleAuthSelect: vi.fn(),
        handleSubscriptionPlanSubmit: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleTokenPlanSubmit: vi.fn(),
        handleApiKeyProviderSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit: vi.fn(),
        openAuthDialog: vi.fn(),
        cancelAuthentication: vi.fn(),
        actions: {
          setAuthState: vi.fn(),
          onAuthError: vi.fn(),
          handleAuthSelect: vi.fn(),
          handleProviderSubmit: vi.fn(),
          handleOpenRouterSubmit: vi.fn(),
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
    describe('Ctrl+O compact mode toggle (issue #3899)', () => {
      const ctrlOKey: Key = {
        name: 'o',
        ctrl: true,
        meta: false,
        shift: false,
        paste: false,
        sequence: '',
      };

      // The global handler is the one that calls compactToggleHasVisualEffect.
      // Mirrors the discriminator pattern used by the renderMode test above.
      const findGlobalKeypressHandler = () =>
        mockedUseKeypress.mock.calls
          .map((call) => call[0])
          .reverse()
          .find(
            (handler): handler is (key: Key) => void =>
              typeof handler === 'function' &&
              handler.toString().includes('compactToggleHasVisualEffect'),
          );

      it('skips refreshStatic on Ctrl+O when history has no tool_group/thought items', () => {
        mockedUseHistory.mockReturnValue({
          history: [
            { type: 'user', id: 1, text: 'hi' },
            { type: 'gemini', id: 2, text: 'hello' },
          ],
          addItem: vi.fn(),
          updateItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
          truncateToItem: vi.fn(),
        });

        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
        mockStdout.write.mockClear();

        const handler = findGlobalKeypressHandler();
        expect(handler).toBeDefined();
        handler!(ctrlOKey);

        // refreshStatic writes ansiEscapes.clearTerminal — its absence
        // proves we took the no-op short-circuit.
        expect(mockStdout.write).not.toHaveBeenCalledWith(
          ansiEscapes.clearTerminal,
        );
      });

      it('calls refreshStatic on Ctrl+O when history contains a tool_group', () => {
        mockedUseHistory.mockReturnValue({
          history: [
            { type: 'user', id: 1, text: 'run ls' },
            {
              type: 'tool_group',
              id: 2,
              tools: [
                {
                  callId: 'c1',
                  name: 'shell',
                  description: 'shell description',
                  status: ToolCallStatus.Success,
                  resultDisplay: undefined,
                  confirmationDetails: undefined,
                },
              ],
            },
          ],
          addItem: vi.fn(),
          updateItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
          truncateToItem: vi.fn(),
        });

        render(
          <AppContainer
            config={mockConfig}
            settings={mockSettings}
            version="1.0.0"
            initializationResult={mockInitResult}
          />,
        );
        mockStdout.write.mockClear();

        const handler = findGlobalKeypressHandler();
        expect(handler).toBeDefined();
        handler!(ctrlOKey);

        expect(mockStdout.write).toHaveBeenCalledWith(
          ansiEscapes.clearTerminal,
        );
      });
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

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
import {
  type HistoryItem,
  type HistoryItemWithoutId,
  ToolCallStatus,
} from './types.js';
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
      removeLastUserMessage: vi.fn().mockResolvedValue(false),
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
    type CapturedCancelSubmit = (info?: {
      pendingItem: HistoryItemWithoutId | null;
      lastTurnUserItem: { id: number; text: string } | null;
      turnProducedMeaningfulContent: boolean;
    }) => void;
    let capturedOnCancelSubmit: CapturedCancelSubmit | null = null;

    // Most cancel tests want auto-restore to be REACHABLE — the new
    // ownership guard requires the cancelled turn to have added a
    // matching user item. This helper builds the info object for the
    // common case (the cancelled turn added the user prompt in the
    // history fixture). Defaults to the fixture's id=1 so the tests
    // that use single-USER history fixtures work without parameterizing.
    const cancelInfoFor = (text: string, id = 1) =>
      ({
        pendingItem: null,
        lastTurnUserItem: { id, text },
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
        return streamReturnValue;
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

      await Promise.resolve();
      await Promise.resolve();

      // No lastTurnUserItem → guard must bail even though the trailing
      // slice looks restore-eligible.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: null,
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

      await Promise.resolve();
      await Promise.resolve();

      // Text mismatch even though id collides — guard bails.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: { id: 1, text: 'a different text' },
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when the model produced meaningful content', async () => {
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

      await Promise.resolve();
      await Promise.resolve();

      // Pass matching lastTurnUserItem so we reach the
      // trailing-only-synthetic guard (the one the test name promises).
      triggerCancel(cancelInfoFor('what time is it?'));

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
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
        turnProducedMeaningfulContent: false,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
      expect(mockRemoveLastUserMessage).not.toHaveBeenCalled();
    });

    it('does not auto-restore when info.turnProducedMeaningfulContent is true (closes the flush-race)', async () => {
      // Race scenario flagged in PR review: pre-cancel flush commits a
      // gemini_content via addItem and then a synthetic thought event
      // replaces pendingHistoryItem. AppContainer's historyRef.current
      // doesn't see the committed content yet (React hasn't
      // re-rendered), so the trailing-only-synthetic check would
      // otherwise pass. `info.turnProducedMeaningfulContent: true`
      // must short-circuit auto-restore regardless.
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

      await Promise.resolve();
      await Promise.resolve();

      // pendingItem is a (synthetic) thought, but turnProducedMeaningfulContent
      // says content DID happen earlier — guard must bail.
      triggerCancel({
        pendingItem: { type: 'gemini_thought', text: 'thinking…' },
        lastTurnUserItem: { id: 1, text: 'what time is it?' },
        turnProducedMeaningfulContent: true,
      });

      expect(mockTruncateToItem).not.toHaveBeenCalled();
      expect(mockSetText).not.toHaveBeenCalled();
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

      await Promise.resolve();
      await Promise.resolve();

      // Same text but a different (later) id — addItem skipped the
      // insert, but the producer-side ref still recorded the
      // freshly-generated id. Guard bails on id mismatch even though
      // text matches.
      triggerCancel({
        pendingItem: null,
        lastTurnUserItem: { id: 999, text: 'foo' },
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
        messageQueue: ['queued thought'],
        addMessage: vi.fn(),
        clearQueue: vi.fn(),
        getQueuedMessagesText: vi.fn().mockReturnValue('queued thought'),
        popAllMessages: vi.fn().mockReturnValue('queued thought'),
        drainQueue: vi.fn().mockReturnValue([]),
        popNextSegment: vi.fn().mockReturnValue('queued thought'),
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

      await Promise.resolve();
      await Promise.resolve();

      // Matching lastTurnUserItem so the test reaches the
      // pending-tool-group bail path (the one the test name promises).
      triggerCancel(cancelInfoFor('edit foo.ts'));

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
      const mockPopAllMessages = vi.fn().mockReturnValue('/model\n\nhi');
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
        popAllMessages: mockPopAllMessages,
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

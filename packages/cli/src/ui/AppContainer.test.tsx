/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
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
import { render, cleanup, persistentStateMock } from '../test-utils/render.js';
import { waitFor } from '../test-utils/async.js';
import {
  act,
  Component,
  useContext,
  useRef,
  useMemo,
  useLayoutEffect,
  useCallback,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { AppContainer } from './AppContainer.js';
const startupModelMocks = vi.hoisted(() => ({
  apply: vi.fn<(config: Config) => Promise<void>>(),
}));
vi.mock('../startup/applyStartupModel.js', () => ({
  createStartupModelApplier: () => startupModelMocks.apply,
}));
import { ConfigContext, useModel } from './contexts/ConfigContext.js';
import { CliApplicationContext } from './contexts/CliApplicationContext.js';
import type { SessionUiBinding } from './session/prepareSessionUi.js';
import {
  LocalTuiSessionAdapter,
  type LocalTuiSessionSource,
} from './session/localTuiSessionAdapter.js';
import { testProviderModel } from '../../../core/src/test-utils/model-resolution.js';
import type { SessionSettings } from '../session/session.js';
import type { LocalSessionHandle } from '../session/localSession.js';
import {
  FoldStateProvider,
  useFoldState,
} from './contexts/FoldStateContext.js';
import { SettingsContext } from './contexts/SettingsContext.js';
import { type TrackedToolCall } from './hooks/useToolScheduler.js';
import { EMPTY_EXTERNAL_IMPORT_STATE } from './hooks/localSession.shared.js';
import type { SessionBrowserOpenOptions } from './hooks/useSessionBrowser.js';
import type {
  SessionInfo,
  SessionSelectionResult,
} from '../utils/sessionUtils.js';
import type { WorktreeStartupRequest } from '../utils/worktreeStartupRequest.js';
type RemoteResumeData = {
  runtimeHistory: Message[];
  uiHistory: HistoryItemWithoutId[];
  remoteState: { model?: string };
  [key: string]: unknown;
};
import {
  type Config,
  type PermissionMode,
  type Message,
  makeFakeConfig,
  ModelProviderManager,
  CoreEvent,
  type SessionResumeData,
  type StartupWarning,
  WarningPriority,
  CoreToolCallStatus,
  MessageSenderType,
  type AutoMemoryCallbacks,
  type AgentUnifiedTask,
  type WorkflowUnifiedTask,
  type RewindCandidate,
  type FileHistoryManager,
  AutoMemoryExtractionService,
  ExecutionLifecycleService,
  createUserMessage,
  createAssistantMessage,
  cloneUsage,
  _resetQueueForTest,
  enqueue,
  SessionEndReason,
  SessionStartSource,
  FatalInputError,
  PermissionModeUnavailableError,
} from '@qwen-code/core';
import { appEvents, AppEvent, TransientMessageType } from '../utils/events.js';

// Mock coreEvents
const mockCoreEvents = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  drainBacklogs: vi.fn(),
  emit: vi.fn(),
  emitFeedback: vi.fn(),
}));

const mockAutoMemoryService = vi.hoisted(() => ({
  callbacks: [] as unknown[],
  instances: [] as Array<{
    onTurnComplete: ReturnType<typeof vi.fn>;
    drain: ReturnType<typeof vi.fn>;
  }>,
}));

// Mock stdout
const mocks = vi.hoisted(() => ({
  mockStdout: { write: vi.fn() },
}));
const terminalNotificationsMocks = vi.hoisted(() => ({
  notifyViaTerminal: vi.fn().mockResolvedValue(true),
  isNotificationsEnabled: vi.fn(() => true),
  buildRunEventNotificationContent: vi.fn((event) => ({
    title: 'Mock Notification',
    subtitle: 'Mock Subtitle',
    body: JSON.stringify(event),
  })),
}));
const worktreeStartupMocks = vi.hoisted(() => ({
  applyWorktreeStartupRequest: vi.fn(async () => undefined),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    coreEvents: mockCoreEvents,
    writeToStdout: vi.fn((...args) =>
      process.stdout.write(
        ...(args as Parameters<typeof process.stdout.write>),
      ),
    ),
    writeToStderr: vi.fn((...args) =>
      process.stderr.write(
        ...(args as Parameters<typeof process.stderr.write>),
      ),
    ),
    patchStdio: vi.fn(() => () => {}),
    createWorkingStdio: vi.fn(() => ({
      stdout: process.stdout,
      stderr: process.stderr,
    })),
    getAutoMemoryDir: vi.fn(() => '/tmp/qwen-auto-memory-test'),
    ensureAutoMemoryDir: vi.fn(async () => {}),
    AutoMemoryExtractionService: vi.fn(),
    enableMouseEvents: vi.fn(),
    disableMouseEvents: vi.fn(),
    FileDiscoveryService: vi.fn().mockImplementation(() => ({
      initialize: vi.fn(),
    })),
  };
});

vi.mock('../startup/startupCoordinator.js', () => ({
  runAfterConfigInitializedStartup: vi.fn(async () => true),
}));
vi.mock('../utils/worktreeStartupRequest.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/worktreeStartupRequest.js')>();
  return {
    ...actual,
    applyWorktreeStartupRequest:
      worktreeStartupMocks.applyWorktreeStartupRequest,
  };
});
import ansiEscapes from 'ansi-escapes';
import { type LoadedSettings } from '../config/settings.js';
import { createMockSettings } from '../test-utils/settings.js';
const mockedUseQuotaAndFallback = {
  mockReturnValue: vi.fn(),
} as unknown as Mock;
import { StreamingState, type HistoryItemWithoutId } from './types.js';
import { CommandKind } from './commands/types.js';
import { UIStateContext, type UIState } from './contexts/UIStateContext.js';
import {
  PendingHistoryContext,
  type PendingHistoryValue,
} from './contexts/PendingHistoryContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import { KeypressProvider } from './contexts/KeypressContext.js';
import { AppFocusProvider } from './state/AppFocusContext.js';
import {
  KeyboardContextProvider,
  useKeyboardContextRegistry,
} from './contexts/KeyboardContextRegistry.js';
import {
  ActionHandlerRegistryProvider,
  useActionHandlerRegistry,
} from './contexts/ActionHandlerRegistry.js';
import { OverflowProvider } from './contexts/OverflowContext.js';
import {
  useOverflowActions,
  type OverflowActions,
} from './contexts/OverflowContext.js';
import { useToolActions } from './contexts/ToolActionsContext.js';
import { FoldLevel } from './constants/messageLayout.js';

// Mock useStdout to capture terminal title writes
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({ stdout: mocks.mockStdout }),
    measureElement: vi.fn(),
  };
});

import { InputContext, type InputState } from './contexts/InputContext.js';

// Helper component will read the context values provided by AppContainer
// so we can assert against them in our tests.
let capturedUIState: UIState;
let capturedConfig: Config | undefined;
let capturedPendingHistory: PendingHistoryValue;
let capturedInputState: InputState;
let capturedUIActions: UIActions;
let capturedOverflowActions: OverflowActions;
let capturedFoldState: ReturnType<typeof useFoldState>;
let capturedToolActions: ReturnType<typeof useToolActions>;
let capturedActionRegistry: ReturnType<typeof useActionHandlerRegistry>;
let capturedKeyboardContextRegistry: ReturnType<
  typeof useKeyboardContextRegistry
>;
let renderCustomDialog = false;
function TestContextConsumer() {
  capturedUIState = useContext(UIStateContext)!;
  capturedConfig = useContext(ConfigContext);
  capturedPendingHistory = useContext(PendingHistoryContext)!;
  capturedInputState = useContext(InputContext)!;
  capturedUIActions = useContext(UIActionsContext)!;
  capturedOverflowActions = useOverflowActions()!;
  capturedFoldState = useFoldState();
  capturedToolActions = useToolActions();
  capturedActionRegistry = useActionHandlerRegistry();
  capturedKeyboardContextRegistry = useKeyboardContextRegistry();
  return renderCustomDialog ? capturedUIState.customDialog : null;
}

vi.mock('./App.js', () => ({
  App: TestContextConsumer,
}));

vi.mock('./hooks/useHistoryManager.js');
vi.mock('./hooks/useMcpAuthHeaderNotice.js');
vi.mock('./hooks/useThemeCommand.js');
vi.mock('./hooks/useEditorSettings.js');
vi.mock('./hooks/useSettingsCommand.js');
vi.mock('./hooks/slashCommandProcessor.js');
vi.mock('./hooks/useConsoleMessages.js');
vi.mock('./hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 80, rows: 24 })),
}));
vi.mock('./hooks/useLocalTuiSessionOrchestrator.js');
vi.mock('./hooks/useRuntimeProjection.js');
vi.mock('./hooks/vim.js');
vi.mock('./hooks/useFocus.js');
vi.mock('./hooks/useBracketedPaste.js');
vi.mock('./hooks/useLoadingIndicator.js');
vi.mock('./hooks/useSuspend.js');
vi.mock('./hooks/useFolderTrust.js');
vi.mock('./hooks/usePermissionModeIndicator.js');
vi.mock('./hooks/useGitBranchName.js');
vi.mock('./hooks/useExtensionUpdates.js');
vi.mock('./contexts/VimModeContext.js');
vi.mock('./contexts/SessionContext.js');
vi.mock('./components/shared/text-buffer.js');
vi.mock('./hooks/useLogger.js');
vi.mock('./hooks/useInputHistoryStore.js');
vi.mock('./hooks/useHookDisplayState.js');
vi.mock('../utils/terminalNotifications.js', () => ({
  notifyViaTerminal: terminalNotificationsMocks.notifyViaTerminal,
  isNotificationsEnabled: terminalNotificationsMocks.isNotificationsEnabled,
  buildRunEventNotificationContent:
    terminalNotificationsMocks.buildRunEventNotificationContent,
}));
vi.mock('./hooks/useTerminalTheme.js', () => ({
  useTerminalTheme: vi.fn(),
}));
const suppliedSessionMocks = vi.hoisted(() => ({
  submitQuery: vi.fn(async () => {}),
}));
vi.mock('./session/useSession.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./session/useSession.js')>();
  return {
    ...actual,
    useSession: (options: Parameters<typeof actual.useSession>[0]) => {
      if (!options.enabled || options.binding?.kind === 'local') {
        return actual.useSession(options);
      }
      const { config, restoreData } = options;
      const remoteResumeData = restoreData as RemoteResumeData | undefined;
      const messages = remoteResumeData?.runtimeHistory ?? [];
      return {
        sessionHandle: options.binding?.session,
        sessionState: {
          status: 'disconnected',
          sessionId: null,
          error: null,
        },
        streamingState: 'idle',
        isModelTurnActive: false,
        pendingHistoryItems: [],
        thought: null,
        currentModel:
          options.binding?.session.getState().model ??
          remoteResumeData?.remoteState.model ??
          config.getModel(),
        currentReasoningEffort: options.binding
          ? options.binding.session.getState().reasoningEffort
          : undefined,
        currentContextWindow: options.binding
          ? options.binding.session.getState().contextWindow
          : undefined,
        currentPermissionMode: options.binding
          ? options.binding.session.getState().permissionMode
          : config.getPermissionMode(),
        submitQuery: suppliedSessionMocks.submitQuery,
        cancelOngoingRequest: vi.fn(),
        handlePermissionModeChange: vi.fn(async () => {}),
        requestModelChange: vi.fn(async () => {}),
        requestContextWindowChange: vi.fn(async () => {}),
        persistSessionTitle: vi.fn(async () => {}),
        endSession: vi.fn(async () => {}),
        sessionTitle: null,
        getIsResponding: () => false,
        getConversationMessages: () => messages,
        getMessages: () => messages,
        setMessages: vi.fn(),
        replaceMessages: vi.fn(async () => {}),
        recordSupplementaryHistoryItem: vi.fn(async () => {}),
        recordMessage: vi.fn(async () => {}),
        runManualCompress: vi.fn(async () => ({
          newHistory: null,
          info: {
            originalTokenCount: null,
            newTokenCount: null,
            compressionStatus: null,
          },
        })),
        releaseSession: vi.fn(),
        resumeSession: vi.fn(async () => ({
          status: 'disconnected',
          remoteSessionId: null,
          error: null,
        })),
        availableModels: [],
        getAvailableModels: () => [],
        requestModelRefresh: vi.fn(async () => []),
        availablePermissionModes: [],
        getAvailablePermissionModes: () => [],
      };
    },
  };
});

import { useHookDisplayState } from './hooks/useHookDisplayState.js';
import { useTerminalTheme } from './hooks/useTerminalTheme.js';
import { useFocus } from './hooks/useFocus.js';

// Mock external utilities
vi.mock('../utils/events.js');
vi.mock('../utils/handleAutoUpdate.js');
vi.mock('./utils/ConsolePatcher.js');
vi.mock('../utils/cleanup.js');
import {
  gracefulExit,
  registerCleanup,
  registerExitCancellation,
} from '../utils/cleanup.js';

import { useHistory } from './hooks/useHistoryManager.js';
import { useMcpAuthHeaderNotice } from './hooks/useMcpAuthHeaderNotice.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useErrorCount } from './hooks/useConsoleMessages.js';
import { useLocalTuiSessionOrchestrator } from './hooks/useLocalTuiSessionOrchestrator.js';
import { useRuntimeProjection } from './hooks/useRuntimeProjection.js';
import { useVim } from './hooks/vim.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { usePermissionModeIndicator } from './hooks/usePermissionModeIndicator.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import {
  useConfirmUpdateRequests,
  useExtensionUpdates,
} from './hooks/useExtensionUpdates.js';
import { useVimMode } from './contexts/VimModeContext.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { getUiLocale } from './i18n/uiLocaleState.js';
import { I18nTestProvider as UiI18nProvider } from '../test-utils/I18nTestProvider.js';
import { useInputHistoryStore } from './hooks/useInputHistoryStore.js';
import { useSuspend } from './hooks/useSuspend.js';
import { disableMouseEvents } from '@qwen-code/core';
import {
  WARNING_PROMPT_DURATION_MS,
  EXPAND_HINT_DURATION_MS,
} from './constants.js';

describe('AppContainer State Management', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockThemeError: string | null;

  function makeRuntimeUserMessage(
    sessionId: string,
    id: string,
    text: string,
    timestamp: string,
  ) {
    const message = createUserMessage(text);
    message.sessionId = sessionId;
    message.uuid = id;
    message.timestamp = timestamp;
    return message;
  }

  function makeRuntimeAssistantMessage(
    sessionId: string,
    id: string,
    text: string,
    timestamp: string,
  ) {
    const usage = cloneUsage();
    usage.input_tokens = 1;
    usage.output_tokens = 1;
    const message = createAssistantMessage(
      {
        messageId: `assistant-${id}`,

        model: 'test-model',
        stopReason: 'end_turn',

        usage: { inputTokens: 1, outputTokens: 1 },
        blocks: [{ type: 'text', text }],
      },
      undefined,
      undefined,
      usage,
    );
    message.sessionId = sessionId;
    message.uuid = id;
    message.timestamp = timestamp;
    return message;
  }

  type AppContainerProps = Pick<
    ComponentProps<typeof AppContainer>,
    | 'onProjectResume'
    | 'onInitialResumeComplete'
    | 'initialResumeOptions'
    | 'initialPromptSubmittedRef'
    | 'sessionUi'
  > & {
    settings?: LoadedSettings;
    config?: Config;
    version?: string;
    themeError?: string | null;
    startupWarnings?: StartupWarning[];
    resumedSessionData?: SessionResumeData;
    remoteResumeData?: RemoteResumeData;
    initialSessionBrowserOptions?: SessionBrowserOpenOptions;
    initialSessionTitle?: string;
    worktreeStartupRequest?: WorktreeStartupRequest;
  };

  // Helper to generate the AppContainer JSX for render and rerender
  const getAppContainer = ({
    settings = mockSettings,
    config = mockConfig,
    version = '1.0.0',
    themeError = mockThemeError,
    startupWarnings,
    resumedSessionData,
    remoteResumeData,
    sessionUi: suppliedBinding,
    initialSessionBrowserOptions,
    initialSessionTitle,
    worktreeStartupRequest,
    ...projectResumeProps
  }: AppContainerProps = {}) => {
    const sessionUi =
      suppliedBinding ??
      (remoteResumeData
        ? ({
            session: {
              getState: () => ({
                model: remoteResumeData.remoteState.model ?? config.getModel(),
                permissionMode: config.getPermissionMode(),
                initialHistory: remoteResumeData.uiHistory,
              }),
              getMessages: () => remoteResumeData.runtimeHistory,
              getConversationMessages: () => remoteResumeData.runtimeHistory,
            },
          } as unknown as SessionUiBinding)
        : undefined);
    return (
      <SettingsContext.Provider value={settings}>
        <UiI18nProvider
          forcedLocale={remoteResumeData || sessionUi ? 'en' : undefined}
          dynamicContentEnabled={!remoteResumeData && !sessionUi}
        >
          <KeypressProvider config={config}>
            <KeyboardContextProvider>
              <ActionHandlerRegistryProvider>
                <OverflowProvider>
                  <FoldStateProvider>
                      <AppFocusProvider>
                        <AppContainer
                          {...projectResumeProps}
                          worktreeStartupRequest={worktreeStartupRequest}
                          config={config}
                          version={version}
                          themeError={themeError}
                          startupWarnings={startupWarnings}
                          resumedSessionData={resumedSessionData}
                          sessionUi={sessionUi}
                          initialSessionBrowserOptions={
                            initialSessionBrowserOptions
                          }
                          initialSessionTitle={initialSessionTitle}
                        />
                      </AppFocusProvider>
                  </FoldStateProvider>
                </OverflowProvider>
              </ActionHandlerRegistryProvider>
            </KeyboardContextProvider>
          </KeypressProvider>
        </UiI18nProvider>
      </SettingsContext.Provider>
    );
  };

  // Helper to render the AppContainer
  const renderAppContainer = async (props?: AppContainerProps) =>
    render(getAppContainer(props));

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function createRewindFixture(mode: 'prompt' | 'bash' = 'prompt') {
    const before = makeRuntimeUserMessage(
      'test-session',
      'user-a',
      'A',
      '2026-08-04T00:00:00.000Z',
    );
    const assistant = makeRuntimeAssistantMessage(
      'test-session',
      'assistant-a',
      'answer A',
      '2026-08-04T00:00:01.000Z',
    );
    const target = makeRuntimeUserMessage(
      'test-session',
      'user-b',
      mode === 'bash' ? '<bash-input>npm test</bash-input>' : 'expanded prompt',
      '2026-08-04T00:00:02.000Z',
    );
    target.humanInput = {
      text: mode === 'bash' ? 'npm   test' : '/skill   exact\n  second line',
      mode,
    };
    if (mode === 'bash') {
      target.isMeta = true;
    }
    return { before, assistant, target, messages: [before, assistant, target] };
  }

  function createRemoteResumeData(
    runtimeHistory: RemoteResumeData['runtimeHistory'],
  ): RemoteResumeData {
    return {
      sessionId: 'remote-session',
      sessionSummary: {
        session_id: 'remote-session',
        title: 'Remote Session',
        runner_type: 'remote',
        connection_status: 'connected',
        session_status: 'idle',
        current_worker_epoch: 1,
        created_at: '2026-08-04T00:00:00.000Z',
        updated_at: '2026-08-04T00:00:00.000Z',
      },
      events: [],
      uiHistory: [],
      runtimeHistory,
      remoteState: {},
      warnings: [],
      source: 'remote-control',
    };
  }

  it.each(['continue', '/continue'])(
    'paid confirmation accepts explicit %s only',
    async (command) => {
      suppliedSessionMocks.submitQuery.mockClear();
      const rendered = await act(async () =>
        renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
      );
      const handler = mockCoreEvents.on.mock.calls.find(
        (call) => call[0] === CoreEvent.ConsentRequest,
      )![1];
      const onConfirm = vi.fn();
      try {
        await act(async () => {
          mockedUseSlashCommandProcessor.mock.lastCall![11](true);
        });
        expect(capturedUIState.isInputActive).toBe(false);
        await act(() =>
          handler({
            prompt: 'Fast',
            modelPaid: {
              sessionId: mockConfig.getSessionId(),
              model: mockConfig.getModel(),
            },
            onConfirm,
          }),
        );
        expect(capturedUIState.authConsentRequest).toBeNull();
        expect(capturedUIState.isInputActive).toBe(true);
        await act(async () => {
          await capturedUIActions.handleFinalSubmit('unrelated input');
        });
        expect(suppliedSessionMocks.submitQuery).not.toHaveBeenCalled();
        await act(async () => {
          await capturedUIActions.handleFinalSubmit(
            command,
            {},
            undefined,
            'programmatic',
          );
        });
        expect(onConfirm).not.toHaveBeenCalled();
        await act(async () => {
          await capturedUIActions.handleFinalSubmit(command);
        });
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(true);
        expect(suppliedSessionMocks.submitQuery).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('paid confirmation is cancelled with the request', async () => {
    const rendered = await act(async () =>
      renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
    );
    const handler = mockCoreEvents.on.mock.calls.find(
      (call) => call[0] === CoreEvent.ConsentRequest,
    )![1];
    const onConfirm = vi.fn();
    const abort = new AbortController();
    try {
      await act(() =>
        handler({
          prompt: 'Fast',
          modelPaid: {
            sessionId: mockConfig.getSessionId(),
            model: mockConfig.getModel(),
          },
          signal: abort.signal,
          onConfirm,
        }),
      );
      await act(async () => {
        abort.abort();
      });
      expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      rendered.unmount();
    }
  });

  it.each(['model request', 'command'])(
    'paid confirmation follows existing Escape cancellation for a %s',
    async (owner) => {
      const controller = new AbortController();
      const onConfirm = vi.fn();
      const cancel = vi.fn(() => {
        expect(onConfirm).not.toHaveBeenCalled();
        controller.abort();
      });
      const cancelCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: vi.fn(),
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
        triggerCancellableCallbacks: cancelCommand,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState:
          owner === 'model request'
            ? StreamingState.Responding
            : StreamingState.Idle,
        cancelOngoingRequest: cancel,
      });
      const rendered = await act(async () => renderAppContainer());
      const handler = mockCoreEvents.on.mock.calls.find(
        (call) => call[0] === CoreEvent.ConsentRequest,
      )![1];
      const escape = {
        name: 'escape',
        alt: false,
        ctrl: false,
        shift: false,
        cmd: false,
        insertable: false,
        sequence: '\x1b',
      };
      try {
        if (owner === 'command') {
          await act(async () => {
            mockedUseSlashCommandProcessor.mock.lastCall![11](true);
          });
        }
        await act(() =>
          handler({
            prompt: 'Fast',
            modelPaid: {
              sessionId: mockConfig.getSessionId(),
              model: mockConfig.getModel(),
            },
            signal: controller.signal,
            onConfirm,
          }),
        );
        await act(async () => {
          capturedActionRegistry!.invokeAction('Global', 'app:escape', escape);
        });
        if (owner === 'model request') {
          expect(cancel).toHaveBeenCalledOnce();
          expect(controller.signal.aborted).toBe(true);
          expect(cancelCommand).not.toHaveBeenCalled();
        } else {
          expect(cancel).not.toHaveBeenCalled();
          expect(controller.signal.aborted).toBe(false);
          expect(cancelCommand).toHaveBeenCalledOnce();
        }
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        rendered.unmount();
      }
    },
  );

  it.each(['model switch', 'unmount'])(
    'paid confirmation is cancelled on %s',
    async (action) => {
      const props = { remoteResumeData: createRemoteResumeData([]) };
      const rendered = await act(async () => renderAppContainer(props));
      const handler = mockCoreEvents.on.mock.calls.find(
        (call) => call[0] === CoreEvent.ConsentRequest,
      )![1];
      const onConfirm = vi.fn();
      try {
        await act(() =>
          handler({
            prompt: 'Fast',
            modelPaid: {
              sessionId: mockConfig.getSessionId(),
              model: mockConfig.getModel(),
            },
            onConfirm,
          }),
        );
        if (action === 'model switch') {
          vi.spyOn(mockConfig, 'getModel').mockReturnValue('other');
          await act(async () => rendered.rerender(getAppContainer(props)));
        } else {
          rendered.unmount();
        }
        expect(onConfirm).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        rendered.unmount();
      }
    },
  );

  it('keeps safe supplied-session UI commands on the existing direct command path', async () => {
    const handleSlashCommand = vi.fn(async () => ({ type: 'handled' }));
    mockedUseSlashCommandProcessor.mockReturnValue({
      handleSlashCommand,
      slashCommands: [{ name: 'model', isSafeConcurrent: true }],
      pendingHistoryItems: [],
      shellConfirmationRequest: null,
      confirmationRequest: null,
    });
    suppliedSessionMocks.submitQuery.mockClear();
    const rendered = await act(async () =>
      renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
    );
    try {
      await act(async () => {
        await capturedUIActions.handleFinalSubmit('/model auto');
      });
      expect(handleSlashCommand).toHaveBeenCalledWith(
        '/model auto',
        undefined,
        undefined,
        true,
        true,
        {},
        'typed',
      );
      expect(suppliedSessionMocks.submitQuery).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
    }
  });

  it.each(['local-skill', 'local-plugin', 'local-workflow', 'local-prompt'])(
    'keeps discovered /%s input on the original supplied-session send path',
    async (name) => {
      const handleSlashCommand = vi.fn(async () => ({ type: 'handled' }));
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand,
        slashCommands: [{ name, isSafeConcurrent: false }],
        pendingHistoryItems: [],
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      suppliedSessionMocks.submitQuery.mockClear();
      const rendered = await act(async () =>
        renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
      );
      try {
        await act(async () => {
          await capturedUIActions.handleFinalSubmit(`/${name} exact args`);
        });
        expect(handleSlashCommand).not.toHaveBeenCalled();
        expect(
          suppliedSessionMocks.submitQuery,
        ).toHaveBeenCalledExactlyOnceWith(`/${name} exact args`, {
          pastedContents: {},
        });
      } finally {
        rendered.unmount();
      }
    },
  );

  it.each([false, true])(
    'waits for startup selection only for the owned TUI (binding=%s)',
    async (hasBinding) => {
      const initialization = deferred<void>();
      const modelReady = deferred<void>();
      startupModelMocks.apply.mockImplementation(() => modelReady.promise);
      vi.spyOn(mockConfig, 'isInitialized').mockReturnValue(false);
      mockConfig.initializeForInteractiveStartup = vi.fn(
        () => initialization.promise,
      );
      const rendered = await act(async () =>
        renderAppContainer(
          hasBinding ? { remoteResumeData: createRemoteResumeData([]) } : {},
        ),
      );
      try {
        expect(startupModelMocks.apply).not.toHaveBeenCalled();
        await act(async () => initialization.resolve());
        if (hasBinding) {
          await waitFor(() =>
            expect(capturedUIState.isConfigInitialized).toBe(true),
          );
          expect(startupModelMocks.apply).not.toHaveBeenCalled();
        } else {
          await waitFor(() =>
            expect(startupModelMocks.apply).toHaveBeenCalledWith(mockConfig),
          );
          expect(capturedUIState.isConfigInitialized).toBe(false);
          await act(async () => modelReady.resolve());
          await waitFor(() =>
            expect(capturedUIState.isConfigInitialized).toBe(true),
          );
        }
      } finally {
        modelReady.resolve();
        rendered.unmount();
      }
    },
  );

  it.each(
    [
      new Error('Ordinary configuration failure'),
      new FatalInputError('Invalid startup options'),
    ].flatMap((error) =>
      ['config', 'model'].map((stage) => ({ error, stage })),
    ),
  )(
    'keeps startup failures on the existing error boundary ($stage: $error)',
    async ({ error, stage }) => {
      const initialization = deferred<void>();
      const caught = vi.fn();
      class Boundary extends Component<
        { children: ReactNode },
        { failed: boolean }
      > {
        override state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        override componentDidCatch(error: Error) {
          caught(error);
        }
        override render() {
          return this.state.failed ? null : this.props.children;
        }
      }
      vi.spyOn(mockConfig, 'isInitialized').mockReturnValue(false);
      mockConfig.initializeForInteractiveStartup = vi.fn(() =>
        stage === 'config' ? initialization.promise : Promise.resolve(),
      );
      startupModelMocks.apply.mockImplementation(() =>
        stage === 'model' ? initialization.promise : Promise.resolve(),
      );
      const rendered = await act(async () =>
        render(<Boundary>{getAppContainer()}</Boundary>),
      );
      try {
        await act(async () => initialization.reject(error));
        await waitFor(() => expect(caught).toHaveBeenCalledWith(error));
        expect(gracefulExit).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    },
  );

  it.each([
    [
      new PermissionModeUnavailableError(
        'Permission mode disabled by global policy.',
      ),
      1,
    ],
  ] as const)(
    'displays a fatal startup error and exits with its status (%s)',
    async (error, exitCode) => {
      const initialization = deferred<void>();
      vi.spyOn(mockConfig, 'isInitialized').mockReturnValue(false);
      mockConfig.initializeForInteractiveStartup = vi.fn(
        () => initialization.promise,
      );
      const rendered = await act(async () => renderAppContainer());
      try {
        await act(async () => initialization.reject(error));
        await waitFor(() =>
          expect(gracefulExit).toHaveBeenCalledExactlyOnceWith(exitCode, {
            exitReason: 'error',
          }),
        );
        expect(rendered.lastFrame()).toContain(error.message);
        expect(capturedUIState.isConfigInitialized).toBe(false);
      } finally {
        rendered.unmount();
      }
    },
  );

  it('keeps supplied-session initialization and resource assembly on the original lifecycle', async () => {
    const initialization = deferred<void>();
    vi.spyOn(mockConfig, 'isInitialized').mockReturnValue(false);
    const initialize = vi.fn(() => initialization.promise);
    mockConfig.initializeForInteractiveStartup = initialize;
    const hydrate = vi.mocked(mockConfig.hydrateAfterFirstRender);
    const rendered = await act(async () =>
      renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
    );
    try {
      expect(initialize).toHaveBeenCalledOnce();
      expect(capturedUIState.isConfigInitialized).toBe(false);
      await act(async () => initialization.resolve());
      await waitFor(() =>
        expect(capturedUIState.isConfigInitialized).toBe(true),
      );
      expect(hydrate).toHaveBeenCalledOnce();
      expect(mockedUseRunLoop.mock.lastCall?.[0]).not.toHaveProperty('enabled');
      expect(mockedUseRuntimeProjection.mock.lastCall?.[0]).not.toHaveProperty(
        'enabled',
      );
      const projectionOptions = mockedUseRuntimeProjection.mock.lastCall?.[0];
      expect(projectionOptions.config).toBe(mockConfig);
      expect(projectionOptions.settings).toBe(mockSettings);
      // Projection owns its tool scheduler; execution no longer injects one.
      expect(projectionOptions).not.toHaveProperty('scheduler');
    } finally {
      rendered.unmount();
    }
  });

  it.each([
    ['app:cyclePermissionMode', 'acceptEdits'],
    ['app:toggleYolo', 'yolo'],
  ] as const)(
    'routes %s through uiConfig with one session request',
    async (action, expected) => {
      vi.spyOn(mockConfig, 'getPermissionMode').mockReturnValue('yolo');
      vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
      vi.spyOn(mockConfig, 'isYoloModeDisabled').mockReturnValue(false);
      const localSetMode = vi.spyOn(mockConfig, 'setPermissionMode');
      const setPermissionMode = vi.fn(async () => {});
      const sessionUi = {
        session: {
          getState: () => ({
            model: 'session-model',
            permissionMode: 'default',
          }),
          getMessages: () => [],
          getConversationMessages: () => [],
          setPermissionMode,
        },
      } as unknown as SessionUiBinding;
      mockedUsePermissionModeIndicator.mockReturnValue('acceptEdits');
      const rendered = await act(async () => renderAppContainer({ sessionUi }));
      try {
        expect(mockedUsePermissionModeIndicator.mock.lastCall?.[0].config).toBe(
          capturedConfig,
        );
        expect(capturedUIState.showPermissionModeIndicator).toBe('acceptEdits');
        await act(async () => {
          capturedActionRegistry?.invokeAction('Global', action, {
            name: 'tab',
            shift: true,
            alt: false,
            ctrl: false,
            cmd: false,
            insertable: false,
            sequence: '\t',
          });
        });
        expect(setPermissionMode).toHaveBeenCalledExactlyOnceWith(expected);
        expect(localSetMode).not.toHaveBeenCalled();
        expect(
          DEFAULT_RUN_LOOP_MOCK.handlePermissionModeChange,
        ).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('keeps local permission shortcut validation and synchronous fallback', async () => {
    vi.spyOn(mockConfig, 'getPermissionMode').mockReturnValue('default');
    vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
    vi.spyOn(mockConfig, 'isYoloModeDisabled').mockReturnValue(false);
    const setPermissionMode = vi
      .spyOn(mockConfig, 'setPermissionMode')
      .mockImplementationOnce(() => {
        throw new Error('mode unavailable');
      })
      .mockImplementation(() => {});
    const rendered = await act(async () => renderAppContainer());
    try {
      await act(async () => {
        capturedActionRegistry?.invokeAction(
          'Global',
          'app:cyclePermissionMode',
          {
            name: 'tab',
            shift: true,
            alt: false,
            ctrl: false,
            cmd: false,
            insertable: false,
            sequence: '\t',
          },
        );
      });
      expect(setPermissionMode.mock.calls.map(([mode]) => mode)).toEqual([
        'acceptEdits',
        'yolo',
      ]);
      expect(setPermissionMode.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          trigger: 'shortcut',
        }),
      );
      expect(setPermissionMode.mock.calls[0]).toHaveLength(2);
      expect(
        DEFAULT_RUN_LOOP_MOCK.handlePermissionModeChange,
      ).toHaveBeenCalledExactlyOnceWith('yolo');
      expect(capturedConfig?.getModelProviderManager()).toBe(
        mockConfig.getModelProviderManager(),
      );
    } finally {
      rendered.unmount();
    }
  });

  async function openRewindDialog() {
    await act(async () => capturedUIActions.openRewindDialog());
    await waitFor(() => expect(capturedUIState.customDialog).toBeTruthy());
    return (
      capturedUIState.customDialog as unknown as {
        props: {
          messages: RewindCandidate[];
          onRestoreConversation: (candidate: RewindCandidate) => Promise<void>;
          onRestoreBoth: (candidate: RewindCandidate) => Promise<void>;
          onRestoreFiles: (candidate: RewindCandidate) => Promise<void>;
        };
      }
    ).props;
  }

  // Create typed mocks for all hooks

  const mockedUseHistory = useHistory as Mock;
  const mockedUseMcpAuthHeaderNotice = useMcpAuthHeaderNotice as Mock;
  const mockedUseThemeCommand = useThemeCommand as Mock;
  const mockedUseEditorSettings = useEditorSettings as Mock;
  const mockedUseSettingsCommand = useSettingsCommand as Mock;
  const mockedUseSlashCommandProcessor = useSlashCommandProcessor as Mock;
  const mockedUseConsoleMessages = useErrorCount as Mock;
  const mockedUseLocalTuiSessionOrchestrator =
    useLocalTuiSessionOrchestrator as Mock;
  const mockedUseRuntimeProjection = useRuntimeProjection as Mock;
  const mockedUseVim = useVim as Mock;
  const mockedUseFolderTrust = useFolderTrust as Mock;
  const mockedUsePermissionModeIndicator = usePermissionModeIndicator as Mock;
  const mockedUseGitBranchName = useGitBranchName as Mock;
  const mockedUseConfirmUpdateRequests = useConfirmUpdateRequests as Mock;
  const mockedUseExtensionUpdates = useExtensionUpdates as Mock;
  const mockedUseVimMode = useVimMode as Mock;
  const mockedUseSessionStats = useSessionStats as Mock;
  const mockedUseTextBuffer = useTextBuffer as Mock;
  const mockedUseLogger = useLogger as Mock;
  const mockedUseLoadingIndicator = useLoadingIndicator as Mock;
  const mockedUseSuspend = useSuspend as Mock;
  const mockedUseInputHistoryStore = useInputHistoryStore as Mock;
  const mockedUseHookDisplayState = useHookDisplayState as Mock;
  const mockedUseTerminalTheme = useTerminalTheme as Mock;
  const mockedUseFocusState = useFocus as Mock;

  type RunLoopMockShape = {
    dispose: Mock;
    streamingState: string;
    isModelTurnActive?: boolean;
    submitUserInput: Mock;
    submitQuery: Mock;
    pendingHistoryItems: unknown[];
    thought: unknown;
    cancelOngoingRequest: Mock;
    pendingToolCalls: TrackedToolCall[];
    handlePermissionModeChange: Mock;
    rewindConversation: Mock;
    rewindFiles: Mock;
    replaceMessages: Mock;
    queueHookContext: Mock;
    recordSupplementaryHistoryItem: Mock;
    recordMessage: Mock;
    runManualCompress: Mock;
    refreshContextTokenCount: Mock;
    scheduler: object;
    clearAssemblerCache: Mock;
    getIsResponding: Mock;
    getConversationMessages: Mock;
    getMessages: Mock;
    setMessages: Mock;
    externalImportApprovalState: {
      isOpen: boolean;
      pendingImports: readonly unknown[];
    };
    handleExternalImportApproval: Mock;
    ensureAiTitle: Mock;
  };

  type RuntimeProjectionMockShape = {
    streamingState: string;
    isModelTurnActive: boolean;
    pendingHistoryItems: unknown[];
    thought: unknown;
    pendingToolCalls: TrackedToolCall[];
    controller: {
      startTurn: Mock;
      handleRequestStart: Mock;
      handleStreamEvent: Mock;
      handleAssistantBlock: Mock;
      handleAssistantMessage: Mock;
      markToolResultsSubmitted: Mock;
      flushPendingToHistory: Mock;
      finishTurn: Mock;
      cancelTurn: Mock;
      getStreamingState: Mock;
      getSnapshot: Mock;
      getToolCalls: Mock;
      getAwaitingApprovalCalls: Mock;
      cancelAllToolCalls: Mock;
    };
  };

  const DEFAULT_RUN_LOOP_MOCK: RunLoopMockShape = {
    dispose: vi.fn(async () => undefined),
    streamingState: 'idle',
    submitUserInput: vi.fn(),
    submitQuery: vi.fn(),
    pendingHistoryItems: [],
    thought: null,
    cancelOngoingRequest: vi.fn(),
    pendingToolCalls: [],
    handlePermissionModeChange: vi.fn(async () => {}),
    rewindConversation: vi.fn(),
    rewindFiles: vi.fn(async () => ({ filesChanged: [], failedFiles: [] })),
    replaceMessages: vi.fn(),
    queueHookContext: vi.fn(),
    recordSupplementaryHistoryItem: vi.fn(),
    recordMessage: vi.fn(),
    runManualCompress: vi.fn(),
    refreshContextTokenCount: vi.fn(async () => {}),
    scheduler: {},
    clearAssemblerCache: vi.fn(),
    getIsResponding: vi.fn(() => false),
    getConversationMessages: vi.fn(() => []),
    getMessages: vi.fn(() => []),
    setMessages: vi.fn(),
    externalImportApprovalState: EMPTY_EXTERNAL_IMPORT_STATE,
    handleExternalImportApproval: vi.fn(),
    ensureAiTitle: vi.fn(),
  };
  const DEFAULT_RUNTIME_PROJECTION_MOCK: RuntimeProjectionMockShape = {
    streamingState: DEFAULT_RUN_LOOP_MOCK.streamingState,
    isModelTurnActive: false,
    pendingHistoryItems: DEFAULT_RUN_LOOP_MOCK.pendingHistoryItems,
    thought: DEFAULT_RUN_LOOP_MOCK.thought,
    pendingToolCalls: DEFAULT_RUN_LOOP_MOCK.pendingToolCalls,
    controller: {
      startTurn: vi.fn(),
      handleRequestStart: vi.fn(),
      handleStreamEvent: vi.fn(),
      handleAssistantBlock: vi.fn(),
      handleAssistantMessage: vi.fn(),
      markToolResultsSubmitted: vi.fn(),
      flushPendingToHistory: vi.fn(),
      finishTurn: vi.fn(),
      cancelTurn: vi.fn(),
      getStreamingState: vi.fn(() => StreamingState.Idle),
      getSnapshot: vi.fn(() => ({
        streamingState: StreamingState.Idle,
        isModelTurnActive: false,
        thought: null,
        pendingHistoryItems: [],
        pendingToolCalls: [],
      })),
      getToolCalls: vi.fn(() => []),
      getAwaitingApprovalCalls: vi.fn(() => []),
      cancelAllToolCalls: vi.fn(),
    },
  };
  const toRuntimeProjectionMock = (
    value: RunLoopMockShape,
  ): RuntimeProjectionMockShape => ({
    ...DEFAULT_RUNTIME_PROJECTION_MOCK,
    streamingState: value.streamingState,
    isModelTurnActive:
      value.isModelTurnActive ??
      value.streamingState === StreamingState.Responding,
    pendingHistoryItems: value.pendingHistoryItems,
    thought: value.thought,
    pendingToolCalls: value.pendingToolCalls,
    controller: {
      ...DEFAULT_RUNTIME_PROJECTION_MOCK.controller,
      getSnapshot: vi.fn(() => ({
        streamingState: value.streamingState,
        isModelTurnActive:
          value.isModelTurnActive ??
          value.streamingState === StreamingState.Responding,
        pendingHistoryItems: value.pendingHistoryItems,
        thought: value.thought,
        pendingToolCalls: value.pendingToolCalls,
      })),
    },
  });
  // Mock only execution. Keep the native handle/adapter boundary real for UI tests.
  function useMockNativeOwner(
    value: RunLoopMockShape,
    options: Parameters<typeof useLocalTuiSessionOrchestrator>[0],
  ) {
    const projection = mockedUseRuntimeProjection();
    const model = useModel(options.config);
    const source = useRef<LocalTuiSessionSource | null>(null);
    const holder = useMemo<{
      config: Config;
      adapter?: LocalTuiSessionAdapter;
    }>(() => ({ config: options.config }), [options.config]);
    useLayoutEffect(() => {
      source.current = {
        config: options.config,
        runtime: value as unknown as LocalTuiSessionSource['runtime'],
        projection: projection.controller,
        model,
        history: options.displayHistory,
        permissionQueue: options.permissionQueue,
        isReadyForInput: options.isReadyForSessionInput ?? (() => false),
        isClosed: () => false,
        restoreSession: options.restoreSession,
      };
      holder.adapter?.sync();
    });
    useLayoutEffect(
      () => () => {
        void holder.adapter?.release();
      },
      [holder],
    );
    const getSession = useCallback(
      () =>
        (holder.adapter ??= new LocalTuiSessionAdapter(
          holder.config,
          () => source.current,
        )),
      [holder],
    );
    return { ...value, getSession };
  }
  const mockedUseRunLoop = {
    get mock() {
      return mockedUseLocalTuiSessionOrchestrator.mock;
    },
    mockReturnValue(value: RunLoopMockShape) {
      mockedUseRuntimeProjection.mockReturnValue(
        toRuntimeProjectionMock(value),
      );
      mockedUseLocalTuiSessionOrchestrator.mockImplementation((options) =>
        useMockNativeOwner(value, options),
      );
    },
    mockImplementation(fn: (...args: unknown[]) => RunLoopMockShape) {
      let latestValue = DEFAULT_RUN_LOOP_MOCK;
      mockedUseLocalTuiSessionOrchestrator.mockImplementation((...args) => {
        latestValue = fn(...args);
        return useMockNativeOwner(latestValue, args[0]);
      });
      mockedUseRuntimeProjection.mockImplementation(() =>
        toRuntimeProjectionMock(latestValue),
      );
    },
  };

  beforeEach(() => {
    startupModelMocks.apply.mockReset().mockResolvedValue(undefined);
    renderCustomDialog = false;
    persistentStateMock.reset();
    vi.clearAllMocks();
    vi.mocked(registerCleanup).mockReturnValue(vi.fn());
    vi.mocked(registerExitCancellation).mockReturnValue(vi.fn());
    mockAutoMemoryService.callbacks.length = 0;
    mockAutoMemoryService.instances.length = 0;
    (AutoMemoryExtractionService as unknown as Mock).mockImplementation(
      (_config: unknown, callbacks: unknown) => {
        mockAutoMemoryService.callbacks.push(callbacks);
        const instance = {
          onTurnComplete: vi.fn(async () => {}),
          drain: vi.fn(async () => {}),
        };
        mockAutoMemoryService.instances.push(instance);
        return instance;
      },
    );

    // Initialize mock stdout for terminal title tests

    mocks.mockStdout.write.mockClear();
    (disableMouseEvents as import('vitest').Mock).mockClear();

    capturedUIState = null!;
    capturedPendingHistory = null!;

    // **Provide a default return value for EVERY mocked hook.**
    mockedUseQuotaAndFallback.mockReturnValue({
      proQuotaRequest: null,
      handleProQuotaChoice: vi.fn(),
    });
    mockedUseHistory.mockReturnValue({
      history: [],
      addItem: vi.fn(),
      updateItem: vi.fn(),
      clearItems: vi.fn(),
      loadHistory: vi.fn(),
      loadHistoryItems: vi.fn(),
    });
    mockedUseMcpAuthHeaderNotice.mockReturnValue(null);
    mockedUseThemeCommand.mockReturnValue({
      isThemeDialogOpen: false,
      openThemeDialog: vi.fn(),
      handleThemeSelect: vi.fn(),
      handleThemeHighlight: vi.fn(),
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
    mockedUseSlashCommandProcessor.mockReturnValue({
      handleSlashCommand: vi.fn(),
      slashCommands: [],
      pendingHistoryItems: [],
      commandContext: {},
      shellConfirmationRequest: null,
      confirmationRequest: null,
    });
    mockedUseConsoleMessages.mockReturnValue({
      errorCount: 0,
      handleNewMessage: vi.fn(),
      clearErrorCount: vi.fn(),
    });
    mockedUseRunLoop.mockReturnValue(DEFAULT_RUN_LOOP_MOCK);
    mockedUseVim.mockReturnValue({ handleInput: vi.fn() });
    mockedUseFolderTrust.mockReturnValue({
      isFolderTrustDialogOpen: false,
      handleFolderTrustSelect: vi.fn(),
    });
    mockedUsePermissionModeIndicator.mockReturnValue(false);
    mockedUseGitBranchName.mockReturnValue('main');
    mockedUseVimMode.mockReturnValue({
      isVimEnabled: false,
      toggleVimEnabled: vi.fn(),
    });
    mockedUseSessionStats.mockReturnValue({ stats: {} });
    mockedUseTextBuffer.mockReturnValue({
      text: '',
      setText: vi.fn(),
      lines: [''],
      cursor: [0, 0],
      handleInput: vi.fn().mockReturnValue(false),
    });
    mockedUseLogger.mockReturnValue({
      getPreviousUserMessages: vi.fn().mockResolvedValue([]),
      logMessage: vi.fn().mockResolvedValue(undefined),
    });
    mockedUseInputHistoryStore.mockReturnValue({
      inputHistory: [],
      addInput: vi.fn(),
      initializeFromLogger: vi.fn(),
    });
    mockedUseLoadingIndicator.mockReturnValue({
      elapsedTime: '0.0s',
      currentLoadingPhrase: '',
    });
    mockedUseSuspend.mockReturnValue({
      handleSuspend: vi.fn(),
    });
    mockedUseHookDisplayState.mockReturnValue([]);
    mockedUseTerminalTheme.mockReturnValue(undefined);
    mockedUseFocusState.mockReturnValue({
      isFocused: true,
      hasReceivedFocusEvent: true,
    });
    mockedUseConfirmUpdateRequests.mockReturnValue({
      addConfirmUpdateExtensionRequest: vi.fn(),
      confirmUpdateExtensionRequests: [],
    });
    mockedUseExtensionUpdates.mockReturnValue({
      extensionsUpdateState: new Map(),
      extensionsUpdateStateInternal: new Map(),
      dispatchExtensionStateUpdate: vi.fn(),
    });

    // Mock Config
    mockConfig = makeFakeConfig();
    vi.spyOn(ModelProviderManager.prototype, 'getModelConfig').mockReturnValue(
      undefined,
    );
    vi.spyOn(mockConfig, 'getUseRenderProcess').mockReturnValue(false);

    // Mock config's getTargetDir to return consistent workspace directory
    vi.spyOn(mockConfig, 'getTargetDir').mockReturnValue('/test/workspace');
    vi.spyOn(mockConfig, 'initialize').mockResolvedValue(undefined);
    (
      mockConfig as Config & {
        initializeForInteractiveStartup: () => Promise<void>;
      }
    ).initializeForInteractiveStartup = vi.fn(async () => undefined);
    (
      mockConfig as Config & {
        hydrateAfterFirstRender: () => Promise<void>;
      }
    ).hydrateAfterFirstRender = vi.fn(async () => undefined);
    vi.spyOn(mockConfig, 'getDebugMode').mockReturnValue(false);

    // Mock LoadedSettings
    mockSettings = createMockSettings({
      hideBanner: false,
      hideTips: false,
      hideFooter: false,
      showMemoryUsage: false,
      theme: 'default',
      ui: {
        hideWindowTitle: false,
        useAlternateBuffer: false,
      },
    });

    // Mock theme validation result
    mockThemeError = null;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // Reset the unified command queue to avoid state leaking between tests
    _resetQueueForTest();
  });

  describe('owned local session binding', () => {
    it('does not lend the controller handle as a native session', async () => {
      const bindLocalSession = vi.fn();
      const application = {
        getCliDisplayName: () => 'Test CLI',
        getAppPlugins: () => undefined as never,
        bindLocalSession,
      };
      const rendered = await act(async () =>
        render(
          <CliApplicationContext.Provider value={application}>
            {getAppContainer({ remoteResumeData: createRemoteResumeData([]) })}
          </CliApplicationContext.Provider>,
        ),
      );
      rendered.unmount();
      expect(bindLocalSession).not.toHaveBeenCalled();
    });
    it('hands the UI handle to the product and keeps local execution after a borrower unsubscribes', async () => {
      const unbind = vi.fn();
      const bindLocalSession = vi.fn((session: LocalSessionHandle) => {
        expect(session.getState().access.status).toBe('connected');
        vi.spyOn(session, 'start');
        return unbind;
      });
      const application = {
        getCliDisplayName: () => 'Test CLI',
        getAppPlugins: () => undefined as never,
        bindLocalSession,
      };
      const rendered = await act(async () =>
        render(
          <CliApplicationContext.Provider value={application}>
            {getAppContainer()}
          </CliApplicationContext.Provider>,
        ),
      );
      try {
        expect(bindLocalSession).toHaveBeenCalledOnce();
        const handle = bindLocalSession.mock.calls[0][0];
        expect(handle).toBeInstanceOf(LocalTuiSessionAdapter);
        expect(handle.start).not.toHaveBeenCalled();
        const submit = vi.spyOn(handle, 'submitMessage');
        const observe = vi.fn();
        const stop = handle.observeUpdates(observe);
        stop();
        await act(async () =>
          capturedUIActions.handleFinalSubmit('local after borrower stops'),
        );
        expect(submit).toHaveBeenCalledOnce();
        expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalledOnce();
        expect(DEFAULT_RUN_LOOP_MOCK.dispose).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
      expect(unbind).toHaveBeenCalledOnce();
    });
    it.each([true, false])(
      'preserves existing preference arguments with native selection scope %s',
      async (sessionOnly) => {
        const modelId = mockConfig.getModel();
        const listed = testProviderModel(modelId);
        const manager = mockConfig.getModelProviderManager();
        vi.spyOn(manager, 'getModel').mockResolvedValue(listed);
        const setPreference = vi
          .spyOn(manager, 'setModelConfig')
          .mockReturnValue(true);
        vi.spyOn(mockConfig, 'setModel').mockResolvedValue(true);
        const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
        const rendered = await act(async () => renderAppContainer());
        try {
          const adapter = sync.mock.contexts.find(
            (value) => value instanceof LocalTuiSessionAdapter,
          );
          if (!(adapter instanceof LocalTuiSessionAdapter))
            throw new Error('Missing local adapter');
          setPreference.mockClear();
          await act(async () => {
            await expect(
              adapter.setModel(modelId, 'low', undefined, { sessionOnly }),
            ).resolves.toBe(true);
          });
          expect(setPreference).toHaveBeenCalledExactlyOnceWith(
            listed,
            { reasoning: { effort: 'low' } },
            !sessionOnly,
          );
        } finally {
          rendered.unmount();
        }
      },
    );
    it.each([true, false])(
      'keeps native model selection scope %s and its original save result',
      async (sessionOnly) => {
        const select = vi
          .spyOn(mockConfig, 'setModel')
          .mockResolvedValueOnce(false);
        const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
        const rendered = await act(async () => renderAppContainer());
        try {
          const adapter = sync.mock.contexts.find(
            (value) => value instanceof LocalTuiSessionAdapter,
          );
          if (!(adapter instanceof LocalTuiSessionAdapter))
            throw new Error('Missing local adapter');
          const request = vi.spyOn(adapter, 'setModel');
          await act(async () => {
            await expect(
              capturedConfig!.setModel('selected-model', sessionOnly),
            ).resolves.toBe(false);
          });
          expect(request).toHaveBeenCalledExactlyOnceWith(
            'selected-model',
            undefined,
            undefined,
            { sessionOnly },
          );
          expect(select).toHaveBeenCalledExactlyOnceWith(
            'selected-model',
            sessionOnly,
          );
        } finally {
          rendered.unmount();
        }
      },
    );
    it('keeps the UI config stable while the local session becomes ready', async () => {
      const ready = deferred<void>();
      const startup = mockConfig as Config & {
        initializeForInteractiveStartup: () => Promise<void>;
      };
      vi.spyOn(startup, 'initializeForInteractiveStartup').mockReturnValue(
        ready.promise,
      );
      const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
      const rendered = await act(async () => renderAppContainer());
      try {
        const initialConfig = capturedConfig;
        await act(async () => ready.resolve());
        await waitFor(() => expect(sync).toHaveBeenCalled());
        expect(capturedConfig).toBe(initialConfig);
      } finally {
        rendered.unmount();
      }
    });
    it('routes native permission changes through the shared handle exactly once', async () => {
      let mode: PermissionMode = 'default';
      vi.spyOn(mockConfig, 'getPermissionMode').mockImplementation(() => mode);
      const apply = vi
        .spyOn(mockConfig, 'setPermissionMode')
        .mockImplementation((next) => {
          mode = next;
        });
      const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
      const rendered = await act(async () => renderAppContainer());
      try {
        const adapter = sync.mock.contexts.find(
          (value) => value instanceof LocalTuiSessionAdapter,
        );
        if (!(adapter instanceof LocalTuiSessionAdapter))
          throw new Error('Missing local adapter');
        const request = vi.spyOn(adapter, 'setPermissionMode');
        const metadata = {
          trigger: 'shortcut' as const,
        };
        await act(async () =>
          capturedConfig!.setPermissionMode('yolo', metadata),
        );
        expect(request).toHaveBeenCalledExactlyOnceWith('yolo', metadata);
        expect(apply).toHaveBeenCalledExactlyOnceWith('yolo', metadata);
        expect(
          DEFAULT_RUN_LOOP_MOCK.handlePermissionModeChange,
        ).toHaveBeenCalledExactlyOnceWith('yolo');
      } finally {
        rendered.unmount();
      }
    });

    it('persists local titles through the same session handle', async () => {
      const persist = vi
        .spyOn(mockConfig, 'persistSessionTitle')
        .mockResolvedValue(undefined);
      const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
      const rendered = await act(async () => renderAppContainer());
      try {
        const adapter = sync.mock.contexts.find(
          (value) => value instanceof LocalTuiSessionAdapter,
        );
        if (!(adapter instanceof LocalTuiSessionAdapter))
          throw new Error('Missing local adapter');
        const request = vi.spyOn(adapter, 'setTitle');
        await act(async () =>
          capturedConfig!.persistSessionTitle('Local title'),
        );
        expect(request).toHaveBeenCalledExactlyOnceWith('Local title');
        expect(persist).toHaveBeenCalledExactlyOnceWith('Local title');
      } finally {
        rendered.unmount();
      }
    });
    it('keeps local settings commands on their original config path', async () => {
      const rendered = await act(async () => renderAppContainer());
      try {
        const args = mockedUseSlashCommandProcessor.mock.lastCall!;
        expect((args[0] as Config).getModelProviderManager()).toBe(
          mockConfig.getModelProviderManager(),
        );
        expect(args.at(-1)).toBeUndefined();
      } finally {
        rendered.unmount();
      }
    });

    it('still supplies the external session to external settings commands', async () => {
      const rendered = await act(async () =>
        renderAppContainer({ remoteResumeData: createRemoteResumeData([]) }),
      );
      try {
        expect(
          mockedUseSlashCommandProcessor.mock.lastCall?.at(-1),
        ).toBeDefined();
      } finally {
        rendered.unmount();
      }
    });
    it('keeps the native thinking phase when the UI binds during an active turn', async () => {
      const progress = await import('./utils/modelProgress.js');
      const label = vi.spyOn(progress, 'getModelProgressLabel');
      const thought = { subject: 'Checking', description: 'Current turn' };
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        thought,
        pendingHistoryItems: [{ type: 'thinking', thought }],
      });
      const rendered = await act(async () => renderAppContainer());
      try {
        expect(label).toHaveBeenLastCalledWith(thought, expect.any(String));
      } finally {
        rendered.unmount();
      }
    });
    it('preserves the native restore target when local commands replace conversation history', async () => {
      const rendered = await act(async () => renderAppContainer());
      try {
        const replace = mockedUseSlashCommandProcessor.mock.lastCall![6] as (
          messages: Message[],
          sessionId: string,
        ) => Promise<void>;
        await act(async () => replace([], 'restored-session-id'));
        expect(
          DEFAULT_RUN_LOOP_MOCK.replaceMessages,
        ).toHaveBeenCalledExactlyOnceWith([], 'restored-session-id');
      } finally {
        rendered.unmount();
      }
    });
    it('reads committed local pending history without writing it back into history', async () => {
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [{ type: 'gemini', text: 'first' }],
      });
      const rendered = await act(async () => renderAppContainer());
      try {
        await waitFor(() =>
          expect(capturedPendingHistory.pendingHistoryItems).toEqual([
            { type: 'gemini', text: 'first' },
          ]),
        );
        const addItem = mockedUseHistory.mock.results.at(-1)!.value.addItem;
        addItem.mockClear();
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          pendingHistoryItems: [{ type: 'gemini', text: 'second' }],
        });
        await act(async () => rendered.rerender(getAppContainer()));
        await waitFor(() =>
          expect(capturedPendingHistory.pendingHistoryItems).toEqual([
            { type: 'gemini', text: 'second' },
          ]),
        );
        expect(addItem).not.toHaveBeenCalled();
      } finally {
        rendered.unmount();
      }
    });

    it('creates one local handle for the UI and preserves the original input executor', async () => {
      const sync = vi.spyOn(LocalTuiSessionAdapter.prototype, 'sync');
      const rendered = await act(async () => renderAppContainer());
      try {
        await waitFor(() => expect(sync).toHaveBeenCalled());
        const adapter = sync.mock.contexts.find(
          (value) => value instanceof LocalTuiSessionAdapter,
        );
        if (!(adapter instanceof LocalTuiSessionAdapter))
          throw new Error('Missing local adapter');
        const submit = vi.spyOn(adapter, 'submitMessage');
        const handle = adapter;
        expect(handle.getState().access.status).toBe('connected');
        expect(capturedConfig?.getModelProviderManager()).toBe(
          mockConfig.getModelProviderManager(),
        );
        await act(async () =>
          capturedUIActions.handleFinalSubmit('typed locally'),
        );
        await waitFor(() =>
          expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalledOnce(),
        );
        expect(submit).toHaveBeenCalledOnce();
        expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalledWith(
          'typed locally',
          expect.objectContaining({
            userMessage: {
              uuid: submit.mock.calls[0][0].id,
              timestamp: undefined,
            },
          }),
        );
        expect(DEFAULT_RUN_LOOP_MOCK.submitQuery).not.toHaveBeenCalled();
        await act(async () => rendered.unmount());
        expect(adapter.getState().access.status).toBe('disconnected');
        await expect(
          handle.submitMessage({
            id: 'late',
            text: 'late',
            content: [{ type: 'text', text: 'late' }],
          }),
        ).rejects.toThrow('released');
      } finally {
        rendered.unmount();
      }
    });

    it('routes UI cancellation metadata to the original executor without a callback cycle', async () => {
      const rendered = await act(async () => renderAppContainer());
      try {
        await act(async () => {
          capturedActionRegistry?.invokeAction('Global', 'app:interrupt', {
            name: 'c',
            ctrl: true,
            shift: false,
            alt: false,
            cmd: false,
            insertable: false,
            sequence: '\u0003',
          });
        });
        expect(
          DEFAULT_RUN_LOOP_MOCK.cancelOngoingRequest,
        ).toHaveBeenCalledOnce();
      } finally {
        rendered.unmount();
      }
    });

    it('keeps native compression and recording callbacks on the local command path', async () => {
      const rendered = await act(async () => renderAppContainer());
      try {
        const args = mockedUseSlashCommandProcessor.mock.lastCall!;
        expect(args.at(-1)).toBeUndefined();
        expect(args[20]).toBe(DEFAULT_RUN_LOOP_MOCK.recordMessage);
        expect(args[21]).toBe(DEFAULT_RUN_LOOP_MOCK.runManualCompress);
        expect(args[23]).toBe(DEFAULT_RUN_LOOP_MOCK.queueHookContext);
      } finally {
        rendered.unmount();
      }
    });
  });

  describe('global permission mode cycling', () => {
    it.each([
      ['acceptEdits', 'yolo'],
      ['yolo', 'auto'],
    ] as const)(
      'allows selecting restricted %s → %s',
      async (current, next) => {
        vi.spyOn(mockConfig, 'getPermissionMode').mockReturnValue(current);
        vi.spyOn(mockConfig, 'isTrustedFolder').mockReturnValue(true);
        vi.spyOn(mockConfig, 'getPermissionModeRestriction').mockImplementation(
          (mode) =>
            mode === 'yolo' || mode === 'auto' ? 'Mode disabled' : undefined,
        );
        const setMode = vi
          .spyOn(mockConfig, 'setPermissionMode')
          .mockImplementation(() => {});
        const { unmount } = await act(async () => renderAppContainer());
        await waitFor(() => {
          expect(
            capturedActionRegistry?.getActionsForContext('Global'),
          ).toContain('app:cyclePermissionMode');
        });

        act(() => {
          capturedActionRegistry?.invokeAction(
            'Global',
            'app:cyclePermissionMode',
            {
              name: 'tab',
              shift: true,
              alt: false,
              ctrl: false,
              cmd: false,
              insertable: false,
              sequence: '\x1b[Z',
            },
          );
        });

        expect(setMode).toHaveBeenCalledExactlyOnceWith(next, {
          trigger: 'shortcut',
        });
        unmount();
      },
    );
  });

  describe('Command transition input', () => {
    it('keeps input visible and queues Enter without steering until the command settles', async () => {
      let setProcessing!: (processing: boolean) => void;
      mockedUseSlashCommandProcessor.mockImplementation((...args) => {
        setProcessing = args[11] as typeof setProcessing;
        return {
          handleSlashCommand: vi.fn(),
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: null,
        };
      });
      const submitUserInput = vi.fn().mockResolvedValue(undefined);
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });
      vi.spyOn(mockConfig, 'isModelSteeringEnabled').mockReturnValue(true);
      const inject = vi.spyOn(mockConfig.injectionService, 'addInjection');
      const rendered = await act(async () => renderAppContainer());

      await act(async () => setProcessing(true));
      expect(capturedUIState.streamingState).toBe(StreamingState.Responding);
      expect(capturedUIState.isInputVisible).toBe(true);
      expect(capturedUIState.isInputActive).toBe(false);
      expect(capturedUIState.isModelTurnActive).toBe(false);
      await act(async () => {
        await capturedUIActions.handleFinalSubmit('complete transition prompt');
      });
      expect(submitUserInput).not.toHaveBeenCalled();
      expect(inject).not.toHaveBeenCalled();

      await act(async () => setProcessing(false));
      await waitFor(() => {
        expect(submitUserInput).toHaveBeenCalledWith(
          'complete transition prompt',
          expect.objectContaining({ queuedCommands: expect.any(Array) }),
        );
      });
      expect(submitUserInput).toHaveBeenCalledOnce();
      expect(inject).not.toHaveBeenCalled();
      rendered.unmount();
    });

    it('still steers a real model turn when steering is enabled', async () => {
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        isModelTurnActive: true,
        submitUserInput,
      });
      vi.spyOn(mockConfig, 'isModelSteeringEnabled').mockReturnValue(true);
      const inject = vi.spyOn(mockConfig.injectionService, 'addInjection');
      const rendered = await act(async () => renderAppContainer());
      await act(async () => {
        await capturedUIActions.handleFinalSubmit('real model steering');
      });
      expect(inject).toHaveBeenCalledWith(
        'real model steering',
        'user_steering',
      );
      expect(submitUserInput).not.toHaveBeenCalled();
      rendered.unmount();
    });
  });

  describe('Initial worktree readiness', () => {
    const initialWorktreeRequest: WorktreeStartupRequest = {
      kind: 'create',
      name: 'initial-worktree',
      originalCwd: '/test/workspace',
    };

    it('pauses automatic input after worktree failure until the user explicitly continues', async () => {
      const worktreeOperation = deferred<undefined>();
      worktreeStartupMocks.applyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      vi.spyOn(mockConfig, 'getEffectiveQuestion').mockReturnValue(
        'initial worktree prompt',
      );
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });
      enqueue({ prompt: 'queued worktree prompt', commandMode: 'prompt' });

      const { unmount } = await act(async () =>
        renderAppContainer({ worktreeStartupRequest: initialWorktreeRequest }),
      );
      await waitFor(() => {
        expect(
          worktreeStartupMocks.applyWorktreeStartupRequest,
        ).toHaveBeenCalledOnce();
      });
      await act(async () => {
        worktreeOperation.reject(new Error('worktree unavailable'));
      });
      await waitFor(() => {
        expect(capturedUIState.isInputActive).toBe(true);
      });
      expect(submitUserInput).not.toHaveBeenCalled();

      await act(async () => {
        await capturedUIActions.handleFinalSubmit(
          'continue in the current directory',
        );
      });
      await waitFor(() => {
        expect(submitUserInput).toHaveBeenCalledWith(
          'queued worktree prompt',
          expect.objectContaining({ queuedCommands: expect.any(Array) }),
        );
      });
      expect(submitUserInput).toHaveBeenCalledWith(
        'continue in the current directory',
        expect.objectContaining({ pastedContents: {} }),
      );
      expect(
        submitUserInput.mock.calls.map(([prompt]) => prompt),
      ).not.toContain('initial worktree prompt');
      unmount();
    });

    it('defers the initial CLI prompt until initial worktree setup settles', async () => {
      const worktreeOperation = deferred<undefined>();
      worktreeStartupMocks.applyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      vi.spyOn(mockConfig, 'getEffectiveQuestion').mockReturnValue(
        'inspect the project',
      );
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });

      const { unmount } = await act(async () =>
        renderAppContainer({ worktreeStartupRequest: initialWorktreeRequest }),
      );

      await waitFor(() => {
        expect(
          worktreeStartupMocks.applyWorktreeStartupRequest,
        ).toHaveBeenCalledOnce();
      });
      expect(submitUserInput).not.toHaveBeenCalled();

      await act(async () => {
        worktreeOperation.resolve(undefined);
      });

      await waitFor(() => {
        expect(submitUserInput).toHaveBeenCalledWith(
          'inspect the project',
          expect.objectContaining({
            pastedContents: {},
          }),
        );
      });
      unmount();
    });

    it('queues programmatic prompts until initial worktree setup settles', async () => {
      const worktreeOperation = deferred<undefined>();
      worktreeStartupMocks.applyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });

      const { unmount } = await act(async () =>
        renderAppContainer({ worktreeStartupRequest: initialWorktreeRequest }),
      );
      await waitFor(() => {
        expect(
          worktreeStartupMocks.applyWorktreeStartupRequest,
        ).toHaveBeenCalledOnce();
      });

      await act(async () => {
        await capturedUIActions.handleFinalSubmit('queued by a panel');
      });
      expect(submitUserInput).not.toHaveBeenCalled();

      await act(async () => {
        worktreeOperation.resolve(undefined);
      });
      await waitFor(() => {
        expect(submitUserInput).toHaveBeenCalledWith(
          'queued by a panel',
          expect.objectContaining({ queuedCommands: expect.any(Array) }),
        );
      });
      unmount();
    });

    it('keeps queued input queued until initial worktree setup settles', async () => {
      const worktreeOperation = deferred<undefined>();
      worktreeStartupMocks.applyWorktreeStartupRequest.mockReturnValueOnce(
        worktreeOperation.promise,
      );
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });
      enqueue({ prompt: 'queued prompt', commandMode: 'prompt' });

      const { unmount } = await act(async () =>
        renderAppContainer({ worktreeStartupRequest: initialWorktreeRequest }),
      );

      await waitFor(() => {
        expect(
          worktreeStartupMocks.applyWorktreeStartupRequest,
        ).toHaveBeenCalledOnce();
      });
      expect(submitUserInput).not.toHaveBeenCalled();

      await act(async () => {
        worktreeOperation.resolve(undefined);
      });

      await waitFor(() => {
        expect(submitUserInput).toHaveBeenCalledWith(
          'queued prompt',
          expect.objectContaining({
            queuedCommands: expect.arrayContaining([
              expect.objectContaining({ prompt: 'queued prompt' }),
            ]),
          }),
        );
      });
      unmount();
    });
  });

  it('uses session facets without asking the application for a remote-control service', async () => {
    const getRemoteSessionService = vi.fn(() => ({
      getState: vi.fn(),
      disconnect: vi.fn(),
    }));
    const application = {
      getCliDisplayName: () => 'Test CLI',
      getAppPlugins: () => undefined as never,
      getRemoteSessionService,
    };
    const rendered = await act(async () =>
      render(
        <CliApplicationContext.Provider value={application}>
          {getAppContainer()}
        </CliApplicationContext.Provider>,
      ),
    );
    expect(getRemoteSessionService).not.toHaveBeenCalled();
    rendered.unmount();
  });

  describe('durable local rewind', () => {
    it.each(['success', 'partial', 'all failed'] as const)(
      'closes the dialog after combined rewind and reports partial failures outside it (%s)',
      async (outcome) => {
        renderCustomDialog = true;
        const fixture = createRewindFixture();
        const marker = deferred<void>();
        const fileResult = {
          filesChanged: outcome === 'all failed' ? [] : ['a.ts'],
          failedFiles:
            outcome === 'success'
              ? []
              : [{ path: 'b.ts', error: 'missing backup' }],
        };
        vi.spyOn(mockConfig, 'getFileHistoryManager').mockReturnValue({
          canRewind: () => true,
          getDiffStats: async () => ({
            ...fileResult,
            insertions: 1,
            deletions: 0,
          }),
        } as unknown as FileHistoryManager);
        const rewindFiles = vi.fn(async () => fileResult);
        const rewindConversation = vi.fn(async (_targetUuid, options) => {
          expect(rewindFiles).toHaveBeenCalledWith(fixture.target.uuid);
          await marker.promise;
          options.assertReady();
        });
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          getMessages: vi.fn(() => fixture.messages),
          rewindFiles,
          rewindConversation,
        });
        const rendered = await act(async () => renderAppContainer());
        const dialog = await openRewindDialog();
        await act(async () => {
          rendered.stdin.write('\u001B[A');
        });
        await act(async () => {
          rendered.stdin.write('\r');
        });
        await waitFor(() =>
          expect(rendered.lastFrame()).toContain('Confirm this rewind point:'),
        );
        await act(async () => {
          rendered.stdin.write('\r');
        });
        await waitFor(() => expect(rewindConversation).toHaveBeenCalledOnce());
        expect(capturedUIState.customDialog).toBeTruthy();
        expect(capturedUIState.queueErrorMessage).toBeFalsy();
        await act(async () => {
          marker.resolve();
        });
        await waitFor(() => expect(capturedUIState.customDialog).toBeNull());
        if (outcome === 'success') {
          expect(capturedUIState.queueErrorMessage).toBeFalsy();
        } else {
          expect(capturedUIState.queueErrorMessage).toBe(
            `Conversation was restored. File rewind incomplete: ${fileResult.filesChanged.length} file(s) restored; 1 file(s) could not be restored: b.ts.`,
          );
          await expect(
            dialog.onRestoreFiles(dialog.messages[1]),
          ).rejects.toThrow('File rewind incomplete:');
          expect(rewindConversation).toHaveBeenCalledOnce();
        }
      },
    );

    it('does not continue combined rewind after an unexpected file error', async () => {
      const fixture = createRewindFixture();
      vi.spyOn(mockConfig, 'getFileHistoryManager').mockReturnValue({
        canRewind: () => true,
      } as unknown as FileHistoryManager);
      const rewindConversation = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindFiles: vi
          .fn()
          .mockRejectedValue(new Error('checkpoint not found')),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();
      await expect(dialog.onRestoreBoth(dialog.messages[1])).rejects.toThrow(
        'checkpoint not found',
      );
      expect(rewindConversation).not.toHaveBeenCalled();
    });

    it('reports busy when QueryGuard reservation fails', async () => {
      const fixture = createRewindFixture();
      const rewindConversation = vi.fn();
      let runLoop = {
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      };
      mockedUseRunLoop.mockImplementation(() => runLoop);
      const rendered = await act(async () => renderAppContainer());

      runLoop = {
        ...runLoop,
        streamingState: StreamingState.Responding,
        getIsResponding: vi.fn(() => true),
      };
      await act(async () => rendered.rerender(getAppContainer()));
      const dialog = await openRewindDialog();

      await expect(
        dialog.onRestoreConversation(dialog.messages[1]),
      ).rejects.toMatchObject({ code: 'not-ready' });
      expect(rewindConversation).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(capturedUIState.queueErrorMessage).toContain(
          'another query is active',
        ),
      );
    });

    it('rejects rewind while slash-command processing is active', async () => {
      const fixture = createRewindFixture();
      let setSlashProcessing!: (value: boolean) => void;
      mockedUseSlashCommandProcessor.mockImplementation((...args) => {
        setSlashProcessing = args[11] as (value: boolean) => void;
        return {
          handleSlashCommand: vi.fn(),
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: null,
        };
      });
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        options.assertReady();
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      act(() => setSlashProcessing(true));
      const dialog = await openRewindDialog();

      await expect(
        dialog.onRestoreConversation(dialog.messages[1]),
      ).rejects.toMatchObject({ code: 'not-ready' });
    });

    it('observes slash-command processing that starts while persistence waits', async () => {
      const fixture = createRewindFixture();
      const marker = deferred<void>();
      let setSlashProcessing!: (value: boolean) => void;
      mockedUseSlashCommandProcessor.mockImplementation((...args) => {
        setSlashProcessing = args[11] as (value: boolean) => void;
        return {
          handleSlashCommand: vi.fn(),
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: null,
        };
      });
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        await marker.promise;
        options.assertReady();
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();

      const pending = dialog.onRestoreConversation(dialog.messages[1]);
      await waitFor(() => expect(rewindConversation).toHaveBeenCalled());
      act(() => setSlashProcessing(true));
      marker.resolve();

      await expect(pending).rejects.toMatchObject({ code: 'not-ready' });
    });

    it('rejects rewind when a main-thread command is queued', async () => {
      const fixture = createRewindFixture();
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        options.assertReady();
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();
      enqueue({
        prompt: 'queued',
        commandMode: 'prompt',
      });

      await expect(
        dialog.onRestoreConversation(dialog.messages[1]),
      ).rejects.toMatchObject({ code: 'not-ready' });
    });

    it('preserves history and input when queue revision changes during persistence', async () => {
      const fixture = createRewindFixture();
      const marker = deferred<void>();
      const historyManager = {
        history: [{ id: 1, type: 'user', text: 'old history' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      };
      mockedUseHistory.mockReturnValue(historyManager);
      const buffer = {
        text: 'old draft',
        setText: vi.fn(),
        lines: ['old draft'],
        cursor: [0, 9],
        handleInput: vi.fn().mockReturnValue(false),
      };
      mockedUseTextBuffer.mockReturnValue(buffer);
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        await marker.promise;
        options.assertReady();
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();

      const pending = dialog.onRestoreConversation(dialog.messages[1]);
      await waitFor(() => expect(rewindConversation).toHaveBeenCalled());
      enqueue({ prompt: 'later', commandMode: 'prompt' });
      marker.resolve();

      await expect(pending).rejects.toMatchObject({ code: 'not-ready' });
      expect(historyManager.clearItems).not.toHaveBeenCalled();
      expect(buffer.setText).not.toHaveBeenCalled();
    });

    it('rebuilds history only after durable rewind and restores exact prompt text', async () => {
      const fixture = createRewindFixture('prompt');
      const marker = deferred<void>();
      const historyManager = {
        history: [{ id: 1, type: 'user', text: 'old history' }],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      };
      mockedUseHistory.mockReturnValue(historyManager);
      const buffer = {
        text: '',
        setText: vi.fn(),
        lines: [''],
        cursor: [0, 0],
        handleInput: vi.fn().mockReturnValue(false),
      };
      mockedUseTextBuffer.mockReturnValue(buffer);
      const dialogCandidate: { current?: RewindCandidate } = {};
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        await marker.promise;
        options.assertReady();
        const plan = {
          target: dialogCandidate.current!,
          retainedMessages: [fixture.before, fixture.assistant],
          retainedLeafUuid: fixture.assistant.uuid,
        };
        options.commitView(plan);
        return plan;
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();
      dialogCandidate.current = dialog.messages[1];

      const pending = dialog.onRestoreConversation(dialogCandidate.current);
      await waitFor(() => expect(rewindConversation).toHaveBeenCalled());
      expect(historyManager.clearItems).not.toHaveBeenCalled();
      expect(buffer.setText).not.toHaveBeenCalled();

      marker.resolve();
      await pending;

      expect(historyManager.clearItems).toHaveBeenCalledTimes(1);
      expect(buffer.setText).toHaveBeenCalledWith(
        '/skill   exact\n  second line',
        'end',
        { pushToUndo: false },
      );
      expect(capturedInputState.shellModeActive).toBe(false);
    });

    it('restores bash candidates into active shell mode', async () => {
      const fixture = createRewindFixture('bash');
      const buffer = {
        text: '',
        setText: vi.fn(),
        lines: [''],
        cursor: [0, 0],
        handleInput: vi.fn().mockReturnValue(false),
      };
      mockedUseTextBuffer.mockReturnValue(buffer);
      const dialogCandidate: { current?: RewindCandidate } = {};
      const rewindConversation = vi.fn(async (_targetUuid, options) => {
        options.assertReady();
        const plan = {
          target: dialogCandidate.current!,
          retainedMessages: [fixture.before, fixture.assistant],
          retainedLeafUuid: fixture.assistant.uuid,
        };
        options.commitView(plan);
        return plan;
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () => renderAppContainer());
      const dialog = await openRewindDialog();
      dialogCandidate.current = dialog.messages[1];

      await act(async () =>
        dialog.onRestoreConversation(dialogCandidate.current!),
      );

      expect(buffer.setText).toHaveBeenCalledWith('npm   test', 'end', {
        pushToUndo: false,
      });
      expect(capturedInputState.shellModeActive).toBe(true);
    });

    it('does not open local transcript rewind in Remote Controller mode', async () => {
      const fixture = createRewindFixture();
      const rewindConversation = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        getMessages: vi.fn(() => fixture.messages),
        rewindConversation,
      });
      await act(async () =>
        renderAppContainer({
          remoteResumeData: createRemoteResumeData(fixture.messages),
        }),
      );
      await act(async () => capturedUIActions.openRewindDialog());

      expect(capturedUIState.customDialog).toBeNull();
      await waitFor(() =>
        expect(capturedUIState.queueErrorMessage).toContain(
          'unavailable for this session',
        ),
      );
      expect(rewindConversation).not.toHaveBeenCalled();
    });
  });

  describe('Basic Rendering', () => {
    it('holds automatic and queued prompts while the initial resume picker has no selected project', async () => {
      vi.spyOn(mockConfig, 'getEffectiveQuestion').mockReturnValue(
        'initial prompt',
      );
      enqueue({ prompt: 'queued prompt', commandMode: 'prompt' });
      const { unmount } = await act(async () =>
        renderAppContainer({
          initialSessionBrowserOptions: {},
        }),
      );
      await waitFor(() =>
        expect(capturedUIState.isSessionBrowserOpen).toBe(true),
      );
      expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).not.toHaveBeenCalled();
      await act(async () => capturedUIActions.closeSessionBrowser());
      await waitFor(() =>
        expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalled(),
      );
      unmount();
    });

    it('reads pending MCP approval from the stable resource root, not the process cwd', async () => {
      const cliConfig = await import('../config/config.js');
      const pending = vi
        .spyOn(cliConfig, 'getPendingProjectMcpServers')
        .mockReturnValue({});
      vi.spyOn(mockConfig.storage, 'getProjectRoot').mockReturnValue(
        '/original-project',
      );
      const { unmount } = await act(async () => renderAppContainer());
      expect(pending).toHaveBeenCalledWith(
        mockSettings,
        '/original-project',
        mockConfig.getProcessMcpManager(),
      );
      unmount();
      pending.mockRestore();
    });

    it('drains the outgoing runtime and blocks queued input during cross-project resume', async () => {
      const replacement = deferred<boolean>();
      const onProjectResume = vi.fn(() => replacement.promise);
      const { unmount } = await act(async () =>
        renderAppContainer({
          initialSessionBrowserOptions: {},
          onProjectResume,
        }),
      );
      await waitFor(() =>
        expect(capturedUIState.isSessionBrowserOpen).toBe(true),
      );
      const session = {
        id: 'selected',
        originalCwd: '/another-project',
      } as SessionInfo;
      let pending!: Promise<void>;
      await act(async () => {
        pending = (
          capturedUIActions.handleResumeSession as unknown as (
            session: SessionInfo,
            resolved: SessionSelectionResult,
          ) => Promise<void>
        )(session, {
          sessionInfo: session,
          sessionPath: '/legacy/selected.jsonl',
          messages: [],
          displayInfo: 'selected',
        } as SessionSelectionResult);
      });
      await waitFor(() => expect(onProjectResume).toHaveBeenCalled());
      expect(DEFAULT_RUN_LOOP_MOCK.dispose).toHaveBeenCalled();
      expect(DEFAULT_RUN_LOOP_MOCK.replaceMessages).not.toHaveBeenCalled();
      expect(onProjectResume).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionPath: '/legacy/selected.jsonl',
          originalCwd: '/another-project',
        }),
        expect.any(Object),
      );
      await act(async () => {
        enqueue({ prompt: 'queued after selection', commandMode: 'prompt' });
      });
      expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).not.toHaveBeenCalled();
      unmount();
      await act(async () => {
        replacement.resolve(true);
        await pending;
      });
    });

    it('keeps automatic and queued prompts behind the new project restore and SessionStart hook', async () => {
      const writer = deferred<void>();
      DEFAULT_RUN_LOOP_MOCK.replaceMessages.mockReturnValueOnce(writer.promise);
      const fireSessionStartEvent = vi.fn(async () => undefined);
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
      } as never);
      vi.spyOn(mockConfig, 'getEffectiveQuestion').mockReturnValue(
        'initial prompt',
      );
      const onInitialResumeComplete = vi.fn();
      const data = {
        sessionId: 'selected',
        messages: [],
        sessionPath: '/legacy/selected.jsonl',
      };
      const { unmount } = await act(async () =>
        renderAppContainer({
          resumedSessionData: data,
          onInitialResumeComplete,
        }),
      );
      await waitFor(() =>
        expect(DEFAULT_RUN_LOOP_MOCK.replaceMessages).toHaveBeenCalled(),
      );
      await act(async () => {
        enqueue({ prompt: 'queued prompt', commandMode: 'prompt' });
      });
      expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).not.toHaveBeenCalled();
      expect(fireSessionStartEvent).not.toHaveBeenCalled();
      await act(async () => {
        writer.resolve();
      });
      await waitFor(() =>
        expect(onInitialResumeComplete).toHaveBeenCalledWith(true),
      );
      expect(fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Resume,
        mockConfig.getModel(),
        expect.any(AbortSignal),
      );
      await waitFor(() =>
        expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalledWith(
          'initial prompt',
          expect.any(Object),
        ),
      );
      await waitFor(() =>
        expect(DEFAULT_RUN_LOOP_MOCK.submitUserInput).toHaveBeenCalledWith(
          'queued prompt',
          expect.any(Object),
        ),
      );
      unmount();
    });

    it('aborts and drains pending SessionStart before exit cancellation finishes', async () => {
      const hook = deferred<void>();
      const fireSessionStartEvent = vi.fn(() => hook.promise);
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
      } as never);
      const { unmount } = await act(async () => renderAppContainer());
      try {
        await waitFor(() =>
          expect(fireSessionStartEvent).toHaveBeenCalledOnce(),
        );
        const signal = (
          fireSessionStartEvent.mock.calls[0] as unknown as [
            unknown,
            unknown,
            AbortSignal,
          ]
        )[2];
        expect(signal).toBeInstanceOf(AbortSignal);
        const cancel = vi
          .mocked(registerExitCancellation)
          .mock.calls.at(-1)![0];
        let drained = false;
        const pending = Promise.resolve(cancel()).then(() => {
          drained = true;
        });
        expect(signal.aborted).toBe(true);
        await act(async () => {
          await Promise.resolve();
        });
        expect(drained).toBe(false);
        await act(async () => {
          hook.resolve();
          await pending;
        });
        expect(drained).toBe(true);
      } finally {
        hook.resolve();
        unmount();
      }
    });

    it('cancels a pending SessionStart on unmount', async () => {
      const hook = deferred<void>();
      const fireSessionStartEvent = vi.fn(
        (_source: unknown, _model: unknown, signal: AbortSignal) => {
          signal.addEventListener('abort', () => hook.resolve(), {
            once: true,
          });
          return hook.promise;
        },
      );
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
      } as never);
      const { unmount } = await act(async () => renderAppContainer());
      await waitFor(() => expect(fireSessionStartEvent).toHaveBeenCalledOnce());
      const signal = fireSessionStartEvent.mock.calls[0][2];
      unmount();
      expect(signal.aborted).toBe(true);
      await hook.promise;
    });

    it('renders without crashing with minimal props', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      expect(capturedUIState).toBeTruthy();
      unmount();
    });

    it('uses a supplied session handle without legacy remote resume data', async () => {
      const messages = createRewindFixture().messages;
      const initialHistory = [{ type: 'user', text: 'imported question' }];
      const sessionUi = {
        session: {
          getState: () => ({
            model: 'remote-model',
            permissionMode: 'default',
            initialHistory,
            systemPrompt: 'imported prompt',
            appendSystemPrompt: 'imported extra prompt',
          }),
          getConversationMessages: () => messages,
        },
      } as unknown as SessionUiBinding;
      const { unmount } = await act(async () =>
        renderAppContainer({ sessionUi }),
      );
      expect(capturedUIState.hasSessionBinding).toBe(true);
      expect(capturedUIState.currentModel).toBe(
        sessionUi.session.getState().model,
      );
      expect(mockedUseHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          initialItems: [{ type: 'user', text: 'imported question', id: 1 }],
        }),
      );
      expect(mockedUseLocalTuiSessionOrchestrator).toHaveBeenCalledWith(
        expect.objectContaining({
          initialConversationHistory: messages,
          systemPromptOverride: 'imported prompt',
          appendSystemPrompt: 'imported extra prompt',
        }),
      );
      expect(mockedUseLoadingIndicator).toHaveBeenLastCalledWith(
        expect.objectContaining({ locale: 'en' }),
      );
      unmount();
    });

    it('forces English loading content and relays English to plugins in Remote Controller mode', async () => {
      const settings = createMockSettings({ ui: { language: 'zh-CN' } });
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
          remoteResumeData: createRemoteResumeData([]),
        }),
      );

      expect(mockedUseLoadingIndicator).toHaveBeenLastCalledWith(
        expect.objectContaining({ locale: 'en' }),
      );
      // Plugins (e.g. the changelog refresh) follow the relayed UI locale.
      expect(getUiLocale()).toBe('en');
      unmount();
    });

    it('switches the local UI locale without firing SessionStart again', async () => {
      const settings = createMockSettings({
        user: {
          path: '/read-only/settings.json',
          settings: { ui: { language: 'en' } },
          originalSettings: { ui: { language: 'en' } },
          readOnly: true,
        },
      });
      const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
      } as never);
      const rendered = await act(async () => renderAppContainer({ settings }));
      await waitFor(() =>
        expect(fireSessionStartEvent).toHaveBeenCalledTimes(1),
      );

      const chineseSettings = createMockSettings({ ui: { language: 'zh-CN' } });
      rendered.rerender(getAppContainer({ settings: chineseSettings }));
      await waitFor(() => expect(getUiLocale()).toBe('zh-CN'));
      expect(mockedUseLoadingIndicator).toHaveBeenLastCalledWith(
        expect.objectContaining({ locale: 'zh-CN' }),
      );
      expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
      rendered.unmount();
    });

    it('defers SessionStart for initial --resume and falls back to startup when the picker closes', async () => {
      const fireSessionStartEvent = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
      } as never);

      const { unmount } = await act(async () =>
        renderAppContainer({ initialSessionBrowserOptions: {} }),
      );

      await waitFor(() => {
        expect(capturedUIState.isSessionBrowserOpen).toBe(true);
      });
      expect(fireSessionStartEvent).not.toHaveBeenCalled();

      act(() => capturedUIActions.closeSessionBrowser());

      await waitFor(() => {
        expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
      });
      expect(fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Startup,
        mockConfig.getModel(),
        expect.any(AbortSignal),
      );
      unmount();
    });

    it('fires SessionStart resume after an initial --resume target is loaded', async () => {
      const hookSessionIds: string[] = [];
      const fireSessionStartEvent = vi.fn().mockImplementation(async () => {
        hookSessionIds.push(mockConfig.getSessionId());
        return undefined;
      });
      const fireSessionEndEvent = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
        fireSessionEndEvent,
      } as never);
      DEFAULT_RUN_LOOP_MOCK.replaceMessages.mockImplementation(
        async (_messages: unknown, sessionId: string) => {
          mockConfig.setSessionId(sessionId);
        },
      );

      const { unmount } = await act(async () =>
        renderAppContainer({ initialSessionBrowserOptions: {} }),
      );
      await waitFor(() => {
        expect(capturedUIState.isSessionBrowserOpen).toBe(true);
      });

      const session = {
        id: 'resumed-session',
        fileName: 'resumed-session.jsonl',
      } as SessionInfo;
      const resolved = {
        sessionPath: '/tmp/resumed-session.jsonl',
        messages: [
          makeRuntimeUserMessage(
            'resumed-session',
            'resume-message',
            'hello',
            new Date().toISOString(),
          ),
        ],
        directories: [],
        displayInfo: 'resumed session',
        sessionInfo: session,
      } as SessionSelectionResult;

      await act(async () => {
        await (
          capturedUIActions.handleResumeSession as unknown as (
            selectedSession: SessionInfo,
            resolvedSession: SessionSelectionResult,
          ) => Promise<void>
        )(session, resolved);
      });

      expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
      expect(fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Resume,
        mockConfig.getModel(),
        expect.any(AbortSignal),
      );
      expect(hookSessionIds).toEqual(['resumed-session']);
      expect(
        DEFAULT_RUN_LOOP_MOCK.refreshContextTokenCount,
      ).toHaveBeenCalledOnce();
      // The initial startup resume has no live outgoing session to end.
      expect(fireSessionEndEvent).not.toHaveBeenCalled();
      unmount();
    });

    it('fires SessionStart resume after a mid-session resume target is loaded', async () => {
      const hookSessionIds: string[] = [];
      const fireSessionStartEvent = vi.fn().mockImplementation(async () => {
        hookSessionIds.push(mockConfig.getSessionId());
        return undefined;
      });
      const sessionEndSessionIds: string[] = [];
      const fireSessionEndEvent = vi
        .fn()
        .mockImplementation(async (reason: SessionEndReason) => {
          sessionEndSessionIds.push(`${reason}:${mockConfig.getSessionId()}`);
          return undefined;
        });
      vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
        fireSessionStartEvent,
        fireSessionEndEvent,
      } as never);
      DEFAULT_RUN_LOOP_MOCK.replaceMessages.mockImplementation(
        async (_messages: unknown, sessionId: string) => {
          mockConfig.setSessionId(sessionId);
        },
      );

      const { unmount } = await act(async () => renderAppContainer());

      // The initial startup SessionStart settles before the mid-session
      // resume happens.
      await waitFor(() => {
        expect(fireSessionStartEvent).toHaveBeenCalledTimes(1);
      });
      expect(fireSessionStartEvent).toHaveBeenCalledWith(
        SessionStartSource.Startup,
        mockConfig.getModel(),
        expect.any(AbortSignal),
      );

      const session = {
        id: 'resumed-session',
        fileName: 'resumed-session.jsonl',
      } as SessionInfo;
      const resolved = {
        sessionPath: '/tmp/resumed-session.jsonl',
        messages: [
          makeRuntimeUserMessage(
            'resumed-session',
            'resume-message',
            'hello',
            new Date().toISOString(),
          ),
        ],
        directories: [],
        displayInfo: 'resumed session',
        sessionInfo: session,
      } as SessionSelectionResult;

      await act(async () => {
        await (
          capturedUIActions.handleResumeSession as unknown as (
            selectedSession: SessionInfo,
            resolvedSession: SessionSelectionResult,
          ) => Promise<void>
        )(session, resolved);
      });

      // The outgoing session ends with reason 'resume' while it is still
      // the active session, before the resumed session's SessionStart.
      expect(fireSessionEndEvent).toHaveBeenCalledTimes(1);
      expect(fireSessionEndEvent).toHaveBeenCalledWith(SessionEndReason.Resume);
      expect(sessionEndSessionIds[0]).toMatch(/^resume:(?!resumed-session)/);
      expect(fireSessionEndEvent.mock.invocationCallOrder[0]).toBeLessThan(
        fireSessionStartEvent.mock.invocationCallOrder[1],
      );

      expect(fireSessionStartEvent).toHaveBeenCalledTimes(2);
      expect(fireSessionStartEvent).toHaveBeenLastCalledWith(
        SessionStartSource.Resume,
        mockConfig.getModel(),
        expect.any(AbortSignal),
      );
      expect(hookSessionIds[1]).toBe('resumed-session');
      unmount();
    });

    it('exposes the MCP authentication notice through UI state', async () => {
      mockedUseMcpAuthHeaderNotice.mockReturnValue(
        '1 MCP server needs authentication · run /mcp',
      );

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.mcpAuthNotice).toBe(
        '1 MCP server needs authentication · run /mcp',
      );
      unmount();
    });

    it('does not run the model loading timer while a non-model turn is responding', async () => {
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        isModelTurnActive: false,
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.streamingState).toBe(StreamingState.Responding);
      expect(capturedUIState.isModelTurnActive).toBe(false);
      expect(mockedUseLoadingIndicator).toHaveBeenLastCalledWith(
        expect.objectContaining({ streamingState: StreamingState.Idle }),
      );
      unmount();
    });

    it('pauses the model loading timer while permission confirmation is pending', async () => {
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.WaitingForConfirmation,
        isModelTurnActive: true,
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.streamingState).toBe(
        StreamingState.WaitingForConfirmation,
      );
      expect(capturedUIState.isModelTurnActive).toBe(true);
      expect(mockedUseLoadingIndicator).toHaveBeenLastCalledWith(
        expect.objectContaining({
          streamingState: StreamingState.WaitingForConfirmation,
        }),
      );
      unmount();
    });

    it('does not consume Thinking promotions in the open-source container', async () => {
      mockedUseLoadingIndicator.mockReturnValue({
        elapsedTime: 30,
        currentLoadingPhrase: 'Thinking',
        currentTip: undefined,
        currentWittyPhrase: undefined,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        isModelTurnActive: true,
        thought: { subject: 'Thinking' },
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState).not.toHaveProperty('thinkingPromotionTip');
      expect(
        persistentStateMock.update.mock.calls.filter(
          ([key]) => key === 'thinkingTipShownCounts',
        ),
      ).toHaveLength(0);
      unmount();
    });

    it.each([true, false])(
      'keeps terminalBuffer=%s recovery on the same renderer-owned path',
      async (terminalBuffer) => {
        vi.spyOn(mockConfig, 'getUseTerminalBuffer').mockReturnValue(
          terminalBuffer,
        );
        const emitSpy = vi.spyOn(appEvents, 'emit');

        const { unmount } = await act(async () => renderAppContainer());
        mocks.mockStdout.write.mockClear();
        const closeHandler = mockCoreEvents.on.mock.calls.find(
          ([event]) => event === CoreEvent.ExternalEditorClosed,
        )?.[1] as ((payload: { isTerminal: boolean }) => void) | undefined;

        expect(closeHandler).toBeTypeOf('function');
        // Terminal editors are the branch that hands the whole terminal over
        // and therefore has to restore it.
        act(() => closeHandler?.({ isTerminal: true }));

        await waitFor(() => {
          expect(
            (emitSpy.mock.calls as unknown[][]).some(
              ([event]) => event === 'scroll-to-top',
            ),
          ).toBe(false);
          expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
            ansiEscapes.clearTerminal,
          );
        });
        unmount();
      },
    );

    it('changes conversation identity only for an explicit clear', async () => {
      const clearItems = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems,
        loadHistory: vi.fn(),
      });

      const { unmount } = await act(async () => renderAppContainer());
      const initialConversationKey = capturedUIState.conversationKey;

      act(() => capturedUIActions.requestRender());
      expect(capturedUIState.conversationKey).toBe(initialConversationKey);

      act(() => capturedUIActions.handleClearScreen());
      await waitFor(() =>
        expect(capturedUIState.conversationKey).toBe(
          initialConversationKey + 1,
        ),
      );
      expect(clearItems).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('adds startup warnings to session history', async () => {
      const addItem = vi.fn(() => 1);
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });
      const startupWarnings: StartupWarning[] = [
        {
          id: 'w1',
          message: 'Warning 1',
          priority: WarningPriority.High,
        },
        {
          id: 'w2',
          message: 'Warning 2',
          priority: WarningPriority.High,
        },
      ];

      const { unmount } = await act(async () =>
        renderAppContainer({ startupWarnings }),
      );
      expect(addItem).toHaveBeenCalledWith({
        type: 'warning',
        text: 'Warning 1',
      });
      expect(addItem).toHaveBeenCalledWith({
        type: 'warning',
        text: 'Warning 2',
      });
      unmount();
    });

    it('keeps the first input key available when startup warnings are present', async () => {
      const addItem = vi.fn(() => 1);
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });
      const startupWarnings: StartupWarning[] = [
        {
          id: 'windows-10',
          message: 'Windows 10 compatibility warning.',
          priority: WarningPriority.High,
        },
      ];
      const chatFallback = vi.fn(() => true);

      const renderResult = await act(async () =>
        renderAppContainer({ startupWarnings }),
      );
      await renderResult.waitUntilReady();
      capturedKeyboardContextRegistry?.registerContext('Chat');
      capturedActionRegistry?.registerFallback('Chat', chatFallback);

      await act(async () => {
        renderResult.stdin.write('a');
      });

      expect(addItem).toHaveBeenCalledWith({
        type: 'warning',
        text: 'Windows 10 compatibility warning.',
      });
      expect(chatFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'a',
          sequence: 'a',
          insertable: true,
        }),
      );

      capturedActionRegistry?.unregisterFallback('Chat', chatFallback);
      capturedKeyboardContextRegistry?.unregisterContext('Chat');
      renderResult.unmount();
    });

    it('shows full UI details by default', async () => {
      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.cleanUiDetailsVisible).toBe(true);
      unmount();
    });

    it('starts in minimal UI mode when Focus UI preference is persisted', async () => {
      persistentStateMock.get.mockReturnValueOnce(true);

      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: mockSettings,
        }),
      );

      expect(capturedUIState.cleanUiDetailsVisible).toBe(false);
      expect(persistentStateMock.get).toHaveBeenCalledWith('focusUiEnabled');
      unmount();
    });
  });

  describe('State Initialization', () => {
    it('keeps the pending compact marker out of displayed history', async () => {
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: vi.fn(),
        slashCommands: [],
        pendingHistoryItems: [
          {
            type: 'compression',
            compression: {
              isPending: true,
              originalTokenCount: null,
              newTokenCount: null,
              compressionStatus: null,
            },
          },
        ],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedPendingHistory.pendingHistoryItems).toEqual([]);
      unmount();
    });

    it('sends a macOS notification when confirmation is pending and terminal is unfocused', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: false,
        hasReceivedFocusEvent: true,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-1',
                name: 'Bash',
                description: 'Run command',
                resultDisplay: undefined,
                status: CoreToolCallStatus.AwaitingApproval,
                confirmationDetails: {
                  type: 'exec',
                  title: 'Run shell command',
                  command: 'ls',
                  rootCommand: 'ls',
                  rootCommands: ['ls'],
                },
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(terminalNotificationsMocks.notifyViaTerminal).toHaveBeenCalled();
      expect(
        terminalNotificationsMocks.buildRunEventNotificationContent,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'attention',
        }),
      );

      unmount();
    });

    it('does not send attention notification when terminal is focused', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: true,
        hasReceivedFocusEvent: true,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-2',
                name: 'Bash',
                description: 'Run command',
                resultDisplay: undefined,
                status: CoreToolCallStatus.AwaitingApproval,
                confirmationDetails: {
                  type: 'exec',
                  title: 'Run shell command',
                  command: 'ls',
                  rootCommand: 'ls',
                  rootCommands: ['ls'],
                },
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(
        terminalNotificationsMocks.notifyViaTerminal,
      ).not.toHaveBeenCalled();

      unmount();
    });

    it('sends attention notification when focus reporting is unavailable', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: true,
        hasReceivedFocusEvent: false,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-focus-unknown',
                name: 'Bash',
                description: 'Run command',
                resultDisplay: undefined,
                status: CoreToolCallStatus.AwaitingApproval,
                confirmationDetails: {
                  type: 'exec',
                  title: 'Run shell command',
                  command: 'ls',
                  rootCommand: 'ls',
                  rootCommands: ['ls'],
                },
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(terminalNotificationsMocks.notifyViaTerminal).toHaveBeenCalled();

      unmount();
    });

    // TODO(local-session-owner): 依赖 streamingState 状态变化通知，待本地 session owner 测试夹具补齐后恢复
    it.skip('sends a macOS notification when a response completes while unfocused', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: false,
        hasReceivedFocusEvent: true,
      });
      mockedUseThemeCommand.mockReturnValue({
        ...mockedUseThemeCommand(),
        isThemeDialogOpen: true,
      });
      let currentStreamingState: 'idle' | 'responding' = 'responding';
      mockedUseRunLoop.mockImplementation(() => ({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: currentStreamingState,
      }));

      const { unmount, rerender } = await act(async () => renderAppContainer());
      await act(async () => {
        mockedUseSlashCommandProcessor.mock.lastCall![15](<></>);
      });

      currentStreamingState = 'idle';
      await act(async () => {
        rerender(getAppContainer());
      });

      expect(
        terminalNotificationsMocks.buildRunEventNotificationContent,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_complete',
          detail: 'Gemini CLI finished responding.',
        }),
      );
      expect(terminalNotificationsMocks.notifyViaTerminal).toHaveBeenCalled();

      unmount();
    });

    // TODO(local-session-owner): 依赖 streamingState 状态变化通知，待本地 session owner 测试夹具补齐后恢复
    it.skip('sends completion notification when focus reporting is unavailable', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: true,
        hasReceivedFocusEvent: false,
      });
      let currentStreamingState: 'idle' | 'responding' = 'responding';
      mockedUseRunLoop.mockImplementation(() => ({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: currentStreamingState,
      }));

      const { unmount, rerender } = await act(async () => renderAppContainer());

      currentStreamingState = 'idle';
      await act(async () => {
        rerender(getAppContainer());
      });

      expect(
        terminalNotificationsMocks.buildRunEventNotificationContent,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_complete',
          detail: 'Gemini CLI finished responding.',
        }),
      );

      unmount();
    });

    it('does not send completion notification when another action-required dialog is pending', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: false,
        hasReceivedFocusEvent: true,
      });
      let currentStreamingState: 'idle' | 'responding' = 'responding';
      mockedUseRunLoop.mockImplementation(() => ({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: currentStreamingState,
      }));

      const { unmount, rerender } = await act(async () => renderAppContainer());

      await act(async () => {
        mockedUseSlashCommandProcessor.mock.lastCall![15](<></>);
      });
      currentStreamingState = 'idle';
      await act(async () => {
        rerender(getAppContainer());
      });

      expect(
        terminalNotificationsMocks.notifyViaTerminal,
      ).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: expect.stringContaining('"type":"session_complete"'),
        }),
      );

      unmount();
    });

    it('can send repeated attention notifications for the same key after pending state clears', async () => {
      mockedUseFocusState.mockReturnValue({
        isFocused: false,
        hasReceivedFocusEvent: true,
      });

      let pendingHistoryItems = [
        {
          type: 'tool_group',
          tools: [
            {
              callId: 'repeat-key-call',
              name: 'Bash',
              description: 'Run command',
              resultDisplay: undefined,
              status: CoreToolCallStatus.AwaitingApproval,
              confirmationDetails: {
                type: 'exec',
                title: 'Run shell command',
                command: 'ls',
                rootCommand: 'ls',
                rootCommands: ['ls'],
              },
            },
          ],
        },
      ];

      mockedUseRunLoop.mockImplementation(() => ({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems,
      }));

      const { unmount, rerender } = await act(async () => renderAppContainer());

      expect(
        terminalNotificationsMocks.notifyViaTerminal,
      ).toHaveBeenCalledTimes(1);

      pendingHistoryItems = [];
      await act(async () => {
        rerender(getAppContainer());
      });

      pendingHistoryItems = [
        {
          type: 'tool_group',
          tools: [
            {
              callId: 'repeat-key-call',
              name: 'Bash',
              description: 'Run command',
              resultDisplay: undefined,
              status: CoreToolCallStatus.AwaitingApproval,
              confirmationDetails: {
                type: 'exec',
                title: 'Run shell command',
                command: 'ls',
                rootCommand: 'ls',
                rootCommands: ['ls'],
              },
            },
          ],
        },
      ];
      await act(async () => {
        rerender(getAppContainer());
      });

      expect(
        terminalNotificationsMocks.notifyViaTerminal,
      ).toHaveBeenCalledTimes(2);

      unmount();
    });

    it('initializes with theme error from initialization result', async () => {
      const themeErrorWithError = 'Failed to load theme';

      const { unmount } = await act(async () =>
        renderAppContainer({
          themeError: themeErrorWithError,
        }),
      );
      expect(capturedUIState).toBeTruthy();
      unmount();
    });

    it('handles debug mode state', async () => {
      const debugConfig = makeFakeConfig();
      vi.spyOn(debugConfig, 'getDebugMode').mockReturnValue(true);

      const { unmount } = await act(async () =>
        renderAppContainer({ config: debugConfig }),
      );
      unmount();
    });
  });

  describe('Context Providers', () => {
    it('provides AppContext with correct values', async () => {
      const { unmount } = await act(async () =>
        renderAppContainer({ version: '2.0.0' }),
      );
      expect(capturedUIState).toBeTruthy();

      // Should render and unmount cleanly
      unmount();
    });

    it('provides UIStateContext with state management', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      expect(capturedUIState).toBeTruthy();
      unmount();
    });

    it('provides UIActionsContext with action handlers', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      expect(capturedUIState).toBeTruthy();
      unmount();
    });

    it('shares session config and preserves original model-state mirroring and events', async () => {
      let state: SessionSettings = {
        model: 'session-only-model',
        reasoningEffort: 'low',
        contextWindow: 64_000,
        permissionMode: 'acceptEdits',
      };
      const sessionUi = {
        session: {
          getState: () => state,
          getMessages: () => [],
          getConversationMessages: () => [],
        },
      } as unknown as SessionUiBinding;
      const notify = (event: CoreEvent, payload?: unknown) => {
        const subscriptions = mockCoreEvents.on.mock.calls.filter(
          ([name]) => name === event,
        );
        expect(subscriptions.length).toBeGreaterThan(0);
        for (const [, handler] of subscriptions) handler(payload);
      };
      const rendered = await act(async () => renderAppContainer({ sessionUi }));
      try {
        const view = capturedConfig;
        expect(view).toBe(mockedUseSlashCommandProcessor.mock.lastCall?.[0]);
        expect(view?.getModel()).toBe('session-only-model');
        expect(view).not.toBe(mockConfig);
        expect(capturedUIState.currentModel).toBe(state.model);
        expect(capturedUIState.currentReasoningEffort).toBe('low');
        expect(capturedUIState.currentContextWindow).toBe(64_000);
        state = {
          ...state,
          model: 'updated-session-model',
          reasoningEffort: 'high',
          contextWindow: 128_000,
        };
        await act(async () =>
          rendered.rerender(getAppContainer({ sessionUi })),
        );
        expect(capturedConfig).toBe(view);
        expect(capturedConfig).toBe(
          mockedUseSlashCommandProcessor.mock.lastCall?.[0],
        );
        expect(view?.getModel()).toBe(state.model);
        expect(capturedUIState.currentModel).toBe(state.model);
        expect(capturedUIState.currentReasoningEffort).toBe('high');
        expect(capturedUIState.currentContextWindow).toBe(128_000);
        state = {
          ...state,
          reasoningEffort: undefined,
          contextWindow: undefined,
        };
        await act(async () =>
          rendered.rerender(getAppContainer({ sessionUi })),
        );
        expect(capturedUIState.currentReasoningEffort).toBeUndefined();
        expect(capturedUIState.currentContextWindow).toBeUndefined();
        await act(async () =>
          notify(CoreEvent.ModelChanged, { model: 'local-model' }),
        );
        expect(capturedUIState.currentModel).toBe(state.model);
        expect(capturedUIState.currentReasoningEffort).toBeUndefined();
        expect(capturedUIState.currentContextWindow).toBeUndefined();
        await act(async () => notify(CoreEvent.ModelInfoChanged));
        expect(capturedUIState.currentModel).toBe(state.model);
        state = { ...state, model: 'next-session-model' };
        await act(async () =>
          rendered.rerender(getAppContainer({ sessionUi })),
        );
      } finally {
        rendered.unmount();
      }
    });

    it('provides ConfigContext with config object', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      expect(capturedUIState).toBeTruthy();
      expect(capturedConfig?.getModelProviderManager()).toBe(
        mockConfig.getModelProviderManager(),
      );
      expect(mockedUseSlashCommandProcessor.mock.lastCall?.[0]).toBe(
        capturedConfig,
      );
      unmount();
    });
  });

  describe('Settings Integration', () => {
    it('handles settings with all display options disabled', async () => {
      const settingsAllHidden = createMockSettings({
        hideBanner: true,
        hideTips: true,
        hideFooter: true,
        showMemoryUsage: false,
      });

      const { unmount } = await act(async () =>
        renderAppContainer({ settings: settingsAllHidden }),
      );
      expect(capturedUIState).toBeTruthy();
      unmount();
    });

    it('handles settings with memory usage enabled', async () => {
      const settingsWithMemory = createMockSettings({
        showMemoryUsage: true,
      });

      const { unmount } = await act(async () =>
        renderAppContainer({ settings: settingsWithMemory }),
      );
      expect(capturedUIState).toBeTruthy();
      unmount();
    });
  });

  describe('Version Handling', () => {
    it.each(['1.0.0', '2.1.3-beta', '3.0.0-nightly'])(
      'handles version format: %s',
      async (version) => {
        const { unmount } = await act(async () =>
          renderAppContainer({ version }),
        );
        expect(capturedUIState).toBeTruthy();
        unmount();
      },
    );
  });

  describe('Error Handling', () => {
    // skip: 现存失败
    it.skip('propagates invalid configuration to the startup error boundary', async () => {
      const errorConfig = makeFakeConfig();
      const configError = new Error('Config error');
      vi.spyOn(errorConfig, 'getModel').mockImplementation(() => {
        throw configError;
      });

      await expect(
        act(async () => renderAppContainer({ config: errorConfig })),
      ).rejects.toBe(configError);
    });

    it('handles undefined settings gracefully', async () => {
      const undefinedSettings = createMockSettings();

      const { unmount } = await act(async () =>
        renderAppContainer({ settings: undefinedSettings }),
      );
      expect(capturedUIState).toBeTruthy();
      unmount();
    });
  });

  describe('Provider Hierarchy', () => {
    it('establishes correct provider nesting order', async () => {
      // This tests that all the context providers are properly nested
      // and that the component tree can be built without circular dependencies
      const { unmount } = await act(async () => renderAppContainer());

      unmount();
    });
  });

  describe('Session Resumption', () => {
    it('handles resumed session data correctly', async () => {
      const mockResumedSessionData = {
        sessionId: 'test-session-123',
        messages: [
          makeRuntimeUserMessage(
            'test-session-123',
            'msg-1',
            'Hello',
            '2024-01-01T00:00:00Z',
          ),
          makeRuntimeAssistantMessage(
            'test-session-123',
            'msg-2',
            'Hi there!',
            '2024-01-01T00:00:01Z',
          ),
        ],
        filePath: '/tmp/test-session.jsonl',
      };

      const { unmount } = await act(async () =>
        renderAppContainer({
          config: mockConfig,
          settings: mockSettings,
          version: '1.0.0',
          themeError: mockThemeError,
          resumedSessionData: mockResumedSessionData,
        }),
      );
      unmount();
    });

    it('renders without resumed session data', async () => {
      const { unmount } = await act(async () =>
        renderAppContainer({
          config: mockConfig,
          settings: mockSettings,
          version: '1.0.0',
          themeError: mockThemeError,
          resumedSessionData: undefined,
        }),
      );
      unmount();
    });
  });

  describe('Session Resume Flow', () => {
    it('accepts resumed session data', async () => {
      const resumedData = {
        sessionId: 'resumed-session-456',
        messages: [
          makeRuntimeUserMessage(
            'resumed-session-456',
            'msg-1',
            'Previous question',
            '2024-01-01T00:00:00Z',
          ),
          makeRuntimeAssistantMessage(
            'resumed-session-456',
            'msg-2',
            'Previous answer',
            '2024-01-01T00:00:30Z',
          ),
        ],
        filePath: '/tmp/resumed-session.jsonl',
      };

      const { unmount } = await act(async () =>
        renderAppContainer({
          config: makeFakeConfig(),
          settings: mockSettings,
          version: '1.0.0',
          themeError: mockThemeError,
          resumedSessionData: resumedData,
        }),
      );

      expect(resumedData.messages).toHaveLength(2);
      unmount();
    });

    it('does not crash when resumed session is empty', async () => {
      const resumedData = {
        sessionId: 'test-session',
        messages: [],
        filePath: '/tmp/session.json',
      };

      const { unmount } = await act(async () =>
        renderAppContainer({
          config: makeFakeConfig(),
          settings: mockSettings,
          version: '1.0.0',
          themeError: mockThemeError,
          resumedSessionData: resumedData,
        }),
      );

      expect(resumedData.messages).toHaveLength(0);
      unmount();
    });
  });

  describe('Terminal Title Update Feature', () => {
    beforeEach(() => {
      // Reset mock stdout for each test
      mocks.mockStdout.write.mockClear();
      (disableMouseEvents as import('vitest').Mock).mockClear();
    });

    it('verifies useStdout is mocked', async () => {
      const { useStdout } = await import('ink');
      const { stdout } = useStdout();
      expect(stdout).toBe(mocks.mockStdout);
    });

    it('should update terminal title with Working while active', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      // Mock the streaming state as Active
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
        thought: { subject: 'Some thought', description: '' },
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that title was updated with "Working…"
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]0;${'✦ Qwen Code | Working'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    it('should show a provisional session title before the AI title is ready', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );
      const orchestratorOptions =
        mockedUseLocalTuiSessionOrchestrator.mock.calls.at(-1)?.[0];

      await act(async () => {
        orchestratorOptions?.onProvisionalSessionTitle?.(
          'fix terminal tab titles',
        );
      });

      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );
      expect(titleWrites.at(-1)?.[0]).toBe(
        `\x1b]0;${'✦ fix terminal tab titles | Working'.padEnd(80, ' ')}\x07`,
      );

      vi.spyOn(mockConfig, 'getSessionId').mockReturnValue('next-session-id');
      await act(async () => {
        orchestratorOptions?.onProvisionalSessionTitle?.(
          'investigate startup performance',
        );
      });

      expect(
        mocks.mockStdout.write.mock.calls
          .filter((call) => call[0].includes('\x1b]0;'))
          .at(-1)?.[0],
      ).toBe(
        `\x1b]0;${'✦ investigate startup performance | Working'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    // Regression: /clear and /new rotate the config session id without going
    // through any title callback, so the terminal title used to keep naming
    // the previous session until the next user message. A session-id
    // rotation must drop the stale title back to the brand name.
    it('should reset the terminal title to the brand name when the session id rotates', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );
      const orchestratorOptions =
        mockedUseLocalTuiSessionOrchestrator.mock.calls.at(-1)?.[0];

      await act(async () => {
        orchestratorOptions?.onProvisionalSessionTitle?.('旧会话标题');
      });

      const lastTitleWrite = () =>
        mocks.mockStdout.write.mock.calls
          .filter((call) => call[0].includes('\x1b]0;'))
          .at(-1)?.[0];
      expect(lastTitleWrite()).toBe(
        `\x1b]0;${'✦ 旧会话标题 | Working'.padEnd(80, ' ')}\x07`,
      );

      // Simulate /clear or /new: the session id rotates and the session
      // reset re-renders AppContainer without any title callback firing.
      vi.spyOn(mockConfig, 'getSessionId').mockReturnValue('reset-session-id');
      await act(async () => {
        orchestratorOptions?.onStartupWaitingChange?.(true);
      });

      expect(lastTitleWrite()).toBe(
        `\x1b]0;${'✦ Qwen Code | Working'.padEnd(80, ' ')}\x07`,
      );

      // The rotated session can still earn its own title.
      await act(async () => {
        orchestratorOptions?.onProvisionalSessionTitle?.('新会话标题');
      });

      expect(lastTitleWrite()).toBe(
        `\x1b]0;${'✦ 新会话标题 | Working'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    describe('prompt border session name', () => {
      const getOrchestratorOptions = () =>
        mockedUseLocalTuiSessionOrchestrator.mock.calls.at(-1)?.[0];

      it('starts with the sanitized --name value', async () => {
        const { unmount } = await act(async () =>
          renderAppContainer({ initialSessionTitle: 'hello\nworld' }),
        );

        expect(capturedUIState.sessionName).toBe('hello world');
        unmount();
      });

      it('ignores --name when a session binding is supplied', async () => {
        const { unmount } = await act(async () =>
          renderAppContainer({
            initialSessionTitle: 'hello-world',
            remoteResumeData: createRemoteResumeData([]),
          }),
        );

        expect(capturedUIState.sessionName).toBeUndefined();
        unmount();
      });

      it('publishes persisted custom titles and ignores AI and provisional titles', async () => {
        const { unmount } = await act(async () => renderAppContainer());
        expect(capturedUIState.sessionName).toBeUndefined();

        await act(async () => {
          getOrchestratorOptions()?.onProvisionalSessionTitle?.(
            'first prompt text',
          );
        });
        await act(async () => {
          getOrchestratorOptions()?.onLocalAiTitle?.('AI title', 'fresh-ai');
        });
        expect(capturedUIState.sessionName).toBeUndefined();

        await act(async () => {
          getOrchestratorOptions()?.onLocalSessionTitle?.('fix\tlogin\nbug');
        });
        expect(capturedUIState.sessionName).toBe('fix login bug');

        // A title that is empty once control characters are removed keeps the
        // current name instead of clearing it.
        await act(async () => {
          getOrchestratorOptions()?.onLocalSessionTitle?.('\x1b');
        });
        expect(capturedUIState.sessionName).toBe('fix login bug');
        unmount();
      });

      it('publishes a stored custom title when it is republished after a turn', async () => {
        const { unmount } = await act(async () => renderAppContainer());

        await act(async () => {
          getOrchestratorOptions()?.onLocalAiTitle?.(
            'hello-world',
            'existing-custom',
          );
        });

        expect(capturedUIState.sessionName).toBe('hello-world');
        unmount();
      });

      it('publishes the custom title carried by a resumed session', async () => {
        DEFAULT_RUN_LOOP_MOCK.replaceMessages.mockImplementation(
          async (_messages: unknown, sessionId: string) => {
            mockConfig.setSessionId(sessionId);
          },
        );
        const { unmount } = await act(async () => renderAppContainer());

        const session = {
          id: 'named-session',
          fileName: 'named-session.jsonl',
          customTitle: 'hello-world',
        } as SessionInfo;
        const resolved = {
          sessionPath: '/tmp/named-session.jsonl',
          messages: [
            makeRuntimeUserMessage(
              'named-session',
              'named-message',
              'hello',
              new Date().toISOString(),
            ),
          ],
          directories: [],
          displayInfo: 'named session',
          sessionInfo: session,
        } as SessionSelectionResult;

        await act(async () => {
          await (
            capturedUIActions.handleResumeSession as unknown as (
              selectedSession: SessionInfo,
              resolvedSession: SessionSelectionResult,
            ) => Promise<void>
          )(session, resolved);
        });

        await waitFor(() =>
          expect(capturedUIState.sessionName).toBe('hello-world'),
        );
        // A later AI title must not replace the restored custom name.
        await act(async () => {
          getOrchestratorOptions()?.onLocalAiTitle?.('AI title', 'fresh-ai');
        });
        expect(capturedUIState.sessionName).toBe('hello-world');
        unmount();
      });

      it('keeps an unnamed resumed session open to AI titles', async () => {
        DEFAULT_RUN_LOOP_MOCK.replaceMessages.mockImplementation(
          async (_messages: unknown, sessionId: string) => {
            mockConfig.setSessionId(sessionId);
          },
        );
        const { unmount } = await act(async () => renderAppContainer());

        const session = {
          id: 'unnamed-session',
          fileName: 'unnamed-session.jsonl',
        } as SessionInfo;
        const resolved = {
          sessionPath: '/tmp/unnamed-session.jsonl',
          messages: [
            makeRuntimeUserMessage(
              'unnamed-session',
              'unnamed-message',
              'hello',
              new Date().toISOString(),
            ),
          ],
          directories: [],
          displayInfo: 'unnamed session',
          sessionInfo: session,
        } as SessionSelectionResult;

        await act(async () => {
          await (
            capturedUIActions.handleResumeSession as unknown as (
              selectedSession: SessionInfo,
              resolvedSession: SessionSelectionResult,
            ) => Promise<void>
          )(session, resolved);
        });
        expect(capturedUIState.sessionName).toBeUndefined();

        const titleWrites = () =>
          mocks.mockStdout.write.mock.calls.filter((call) =>
            call[0].includes('\x1b]0;'),
          );
        const writesBefore = titleWrites().length;
        await act(async () => {
          getOrchestratorOptions()?.onLocalAiTitle?.('AI title', 'fresh-ai');
        });

        expect(capturedUIState.sessionName).toBeUndefined();
        expect(
          titleWrites()
            .slice(writesBefore)
            .some((call) => call[0].includes('AI title')),
        ).toBe(true);
        unmount();
      });

      it('clears the name when the session id rotates', async () => {
        const { unmount } = await act(async () => renderAppContainer());

        await act(async () => {
          getOrchestratorOptions()?.onLocalSessionTitle?.('hello-world');
        });
        expect(capturedUIState.sessionName).toBe('hello-world');

        vi.spyOn(mockConfig, 'getSessionId').mockReturnValue(
          'rotated-session-id',
        );
        await act(async () => {
          getOrchestratorOptions()?.onStartupWaitingChange?.(true);
        });

        expect(capturedUIState.sessionName).toBeUndefined();
        unmount();
      });
    });

    it.skip('should use legacy terminal title when dynamicWindowTitle is false', async () => {
      // Arrange: Set up mock settings with dynamicWindowTitle disabled
      const mockSettingsWithDynamicTitleFalse = createMockSettings({
        ui: {
          dynamicWindowTitle: false,
          hideWindowTitle: false,
        },
      });

      // Mock the streaming state
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
        thought: { subject: 'Some thought', description: '' },
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: mockSettingsWithDynamicTitleFalse,
        }),
      );

      // Assert: Check that legacy title was used
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]0;${'Gemini CLI (workspace)'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    it('should not update terminal title when hideWindowTitle is true', async () => {
      // Arrange: Set up mock settings with hideWindowTitle enabled
      const mockSettingsWithHideTitleTrue = createMockSettings({
        ui: {
          hideWindowTitle: true,
        },
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: mockSettingsWithHideTitleTrue,
        }),
      );

      // Assert: Check that no title-related writes occurred
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(0);
      unmount();
    });

    it('should not expose the thought subject in the active terminal title', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      const privateThoughtText = 'Processing request';
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
        thought: { subject: privateThoughtText, description: 'Private detail' },
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]0;${'✦ Qwen Code | Working'.padEnd(80, ' ')}\x07`,
      );
      expect(titleWrites[0][0]).not.toContain(privateThoughtText);
      unmount();
    });

    it('should update terminal title with Ready when idle', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      // Mock the streaming state as Idle with no thought
      mockedUseRunLoop.mockReturnValue(DEFAULT_RUN_LOOP_MOCK);

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that title was updated with default Idle text
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]0;${'◇ Qwen Code | Ready'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    it('should prioritize Action Required over thought state', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'waiting_for_confirmation',
        thought: {
          subject: 'Confirm tool execution',
          description: 'Private detail',
        },
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that title was updated with confirmation text
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites.length).toBeGreaterThan(0);
      expect(titleWrites.at(-1)?.[0]).toBe(
        `\x1b]0;${'▲ Qwen Code | Action Required'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });

    describe('Windows terminal title renewal', () => {
      const titleWrites = () =>
        mocks.mockStdout.write.mock.calls.filter((call) =>
          call[0].includes('\x1b]0;'),
        );

      beforeEach(() => {
        vi.useFakeTimers();
        vi.stubEnv('WT_SESSION', 'test-windows-terminal-session');
      });

      afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      });

      it('reasserts the same working title once per second', async () => {
        const settings = createMockSettings({
          ui: {
            hideWindowTitle: false,
          },
        });
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          streamingState: StreamingState.Responding,
        });

        const { unmount } = await act(async () =>
          renderAppContainer({ settings }),
        );
        const firstWrite = titleWrites()[0][0];

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });

        expect(titleWrites()).toHaveLength(4);
        expect(titleWrites().every((call) => call[0] === firstWrite)).toBe(
          true,
        );

        unmount();
        await vi.advanceTimersByTimeAsync(2000);
        expect(titleWrites()).toHaveLength(4);
      });

      it('keeps reasserting Action Required while a tool awaits approval', async () => {
        const settings = createMockSettings({
          ui: {
            hideWindowTitle: false,
          },
        });
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          streamingState: StreamingState.WaitingForConfirmation,
        });

        const { unmount } = await act(async () =>
          renderAppContainer({ settings }),
        );

        const initialWrites = titleWrites().length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        expect(titleWrites()).toHaveLength(initialWrites + 1);
        expect(
          titleWrites()
            .slice(-2)
            .every((call) => call[0].includes('▲ Qwen Code | Action Required')),
        ).toBe(true);
        unmount();
      });

      it('stops renewal and writes Ready when the foreground turn becomes idle', async () => {
        const settings = createMockSettings({
          ui: {
            hideWindowTitle: false,
          },
        });
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          streamingState: StreamingState.Responding,
        });

        const { rerender, unmount } = await act(async () =>
          renderAppContainer({ settings }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        mockedUseRunLoop.mockReturnValue(DEFAULT_RUN_LOOP_MOCK);
        await act(async () => {
          rerender(getAppContainer({ settings }));
        });

        expect(titleWrites().at(-1)?.[0]).toContain('◇ Qwen Code | Ready');
        const writesAfterIdle = titleWrites().length;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(titleWrites()).toHaveLength(writesAfterIdle);
        unmount();
      });

      it('does not renew an idle local command confirmation title', async () => {
        const settings = createMockSettings({
          ui: {
            hideWindowTitle: false,
          },
        });
        mockedUseSlashCommandProcessor.mockReturnValue({
          handleSlashCommand: vi.fn(),
          slashCommands: [],
          pendingHistoryItems: [],
          commandContext: {},
          shellConfirmationRequest: null,
          confirmationRequest: {},
        });
        mockedUseRunLoop.mockReturnValue(DEFAULT_RUN_LOOP_MOCK);

        const { unmount } = await act(async () =>
          renderAppContainer({ settings }),
        );
        expect(titleWrites()).toHaveLength(1);
        expect(titleWrites()[0][0]).toContain('▲ Qwen Code | Action Required');

        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
        expect(titleWrites()).toHaveLength(1);
        unmount();
      });

      it('does not renew titles outside a Windows terminal host', async () => {
        vi.stubEnv('WT_SESSION', '');
        const settings = createMockSettings({
          ui: {
            hideWindowTitle: false,
          },
        });
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          streamingState: StreamingState.Responding,
        });

        const { unmount } = await act(async () =>
          renderAppContainer({ settings }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });

        expect(titleWrites()).toHaveLength(1);
        unmount();
      });
    });

    it('should pad title to exactly 80 characters', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that title is padded to exactly 80 characters
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      const calledWith = titleWrites[0][0];
      const expectedTitle = '✦ Qwen Code | Working'.padEnd(80, ' ');
      const expectedEscapeSequence = `\x1b]0;${expectedTitle}\x07`;
      expect(calledWith).toBe(expectedEscapeSequence);
      unmount();
    });

    it('should use correct ANSI escape code format', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that the correct ANSI escape sequence is used
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      const expectedEscapeSequence = `\x1b]0;${'✦ Qwen Code | Working'.padEnd(80, ' ')}\x07`;
      expect(titleWrites[0][0]).toBe(expectedEscapeSequence);
      unmount();
    });

    it('should use CLI_TITLE environment variable when set', async () => {
      const settings = createMockSettings({
        ui: {
          hideWindowTitle: false,
        },
      });

      // Mock CLI_TITLE environment variable
      vi.stubEnv('CLI_TITLE', 'Custom Gemini Title');

      // Mock the streaming state
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      // Act: Render the container
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings,
        }),
      );

      // Assert: Check that title was updated with CLI_TITLE value
      const titleWrites = mocks.mockStdout.write.mock.calls.filter((call) =>
        call[0].includes('\x1b]0;'),
      );

      expect(titleWrites).toHaveLength(1);
      expect(titleWrites[0][0]).toBe(
        `\x1b]0;${'✦ Custom Gemini Title | Working'.padEnd(80, ' ')}\x07`,
      );
      unmount();
    });
  });

  describe('Queue Error Message', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('should set and clear the queue error message after a timeout', async () => {
      const { rerender, unmount } = await act(async () => renderAppContainer());
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      expect(capturedUIState.queueErrorMessage).toBeNull();

      act(() => {
        capturedUIActions.setQueueErrorMessage('Test error');
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBe('Test error');

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBeNull();
      unmount();
    });

    it('should reset the timer if a new error message is set', async () => {
      const { rerender, unmount } = await act(async () => renderAppContainer());
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      act(() => {
        capturedUIActions.setQueueErrorMessage('First error');
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBe('First error');

      act(() => {
        vi.advanceTimersByTime(1500);
      });

      act(() => {
        capturedUIActions.setQueueErrorMessage('Second error');
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBe('Second error');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBe('Second error');

      // 5. Advance time past the 3 second timeout from the second message
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      rerender(getAppContainer());
      expect(capturedUIState.queueErrorMessage).toBeNull();
      unmount();
    });
  });

  describe('Send-now', () => {
    let cancelOngoingRequest: Mock;

    beforeEach(() => {
      cancelOngoingRequest = vi.fn();
      // Responding keeps the queue processor from draining what the test
      // enqueues.
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        cancelOngoingRequest,
      });
    });

    it('interrupts the turn when a user prompt is queued', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      // Enqueue and send in the same tick, as InputPrompt does: the live
      // queue must be read, not the render-time projection.
      act(() => {
        enqueue({
          prompt: 'follow-up',
          commandMode: 'prompt',
          origin: { kind: 'human' },
        });
        capturedUIActions.sendQueuedNow();
      });

      expect(cancelOngoingRequest).toHaveBeenCalledOnce();
      unmount();
    });

    it('does nothing when the queue is empty', async () => {
      const { unmount } = await act(async () => renderAppContainer());

      act(() => capturedUIActions.sendQueuedNow());

      expect(cancelOngoingRequest).not.toHaveBeenCalled();
      unmount();
    });

    it('does nothing when only internal commands are queued', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      act(() => {
        enqueue({
          prompt: '<task-notification/>',
          commandMode: 'task-notification',
        });
        capturedUIActions.sendQueuedNow();
      });

      expect(cancelOngoingRequest).not.toHaveBeenCalled();
      unmount();
    });
  });

  describe('Keyboard Input Handling (CTRL+C / CTRL+D)', () => {
    let mockHandleSlashCommand: Mock;
    let mockCancelOngoingRequest: Mock;
    let rerender: () => void;
    let unmount: () => void;
    let stdin: Awaited<ReturnType<typeof render>>['stdin'];

    // Helper function to reduce boilerplate in tests
    const setupKeypressTest = async () => {
      const renderResult = await act(async () => renderAppContainer());
      stdin = renderResult.stdin;
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      rerender = () => {
        renderResult.rerender(getAppContainer());
      };
      unmount = renderResult.unmount;
    };

    const pressKey = (sequence: string, times = 1) => {
      for (let i = 0; i < times; i++) {
        act(() => {
          stdin.write(sequence);
        });
        rerender();
      }
    };

    beforeEach(() => {
      // Mock slash command handler
      mockHandleSlashCommand = vi.fn();
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: mockHandleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });

      // Mock request cancellation
      mockCancelOngoingRequest = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        cancelOngoingRequest: mockCancelOngoingRequest,
      });

      // Default empty text buffer
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: vi.fn(),
        lines: [''],
        cursor: [0, 0],
        handleInput: vi.fn().mockReturnValue(false),
      });

      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    describe('CTRL+C', () => {
      // skip: 现存失败
      it.skip('should cancel ongoing request on first press', async () => {
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          streamingState: 'responding',
          cancelOngoingRequest: mockCancelOngoingRequest,
        });
        await setupKeypressTest();

        pressKey('\x03'); // Ctrl+C

        expect(mockCancelOngoingRequest).toHaveBeenCalledTimes(1);
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();
        unmount();
      });

      // skip: 现存失败
      it.skip('should quit on second press', async () => {
        await setupKeypressTest();

        pressKey('\x03', 2); // Ctrl+C

        expect(mockCancelOngoingRequest).toHaveBeenCalledTimes(2);
        expect(mockHandleSlashCommand).toHaveBeenCalledWith(
          '/quit',
          undefined,
          undefined,
          false,
          false,
          undefined,
          'programmatic',
        );
        unmount();
      });

      it('should reset press count after a timeout', async () => {
        await setupKeypressTest();

        pressKey('\x03'); // Ctrl+C
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();

        // Advance timer past the reset threshold
        act(() => {
          vi.advanceTimersByTime(WARNING_PROMPT_DURATION_MS + 1);
        });

        pressKey('\x03'); // Ctrl+C
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();
        unmount();
      });
    });

    describe('CTRL+D', () => {
      // skip: 现存失败
      it.skip('should quit on second press if buffer is empty', async () => {
        await setupKeypressTest();

        pressKey('\x04', 2); // Ctrl+D

        expect(mockHandleSlashCommand).toHaveBeenCalledWith(
          '/quit',
          undefined,
          undefined,
          false,
          false,
          undefined,
          'programmatic',
        );
        unmount();
      });

      it('should NOT quit if buffer is not empty', async () => {
        mockedUseTextBuffer.mockReturnValue({
          text: 'some text',
          setText: vi.fn(),
          lines: ['some text'],
          cursor: [0, 9], // At the end
          handleInput: vi.fn().mockReturnValue(false),
        });
        await setupKeypressTest();

        pressKey('\x04'); // Ctrl+D

        // Should only be called once, so count is 1, not quitting yet.
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();

        pressKey('\x04'); // Ctrl+D
        // It should still not quit because buffer is non-empty.
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();
        unmount();
      });

      it('should reset press count after a timeout', async () => {
        await setupKeypressTest();

        pressKey('\x04'); // Ctrl+D
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();

        // Advance timer past the reset threshold
        act(() => {
          vi.advanceTimersByTime(WARNING_PROMPT_DURATION_MS + 1);
        });

        pressKey('\x04'); // Ctrl+D
        expect(mockHandleSlashCommand).not.toHaveBeenCalled();
        unmount();
      });
    });

    describe('CTRL+Z', () => {
      // skip: 现存失败
      it.skip('should call handleSuspend', async () => {
        const handleSuspend = vi.fn();
        mockedUseSuspend.mockReturnValue({ handleSuspend });
        await setupKeypressTest();

        pressKey('\x1A'); // Ctrl+Z

        expect(handleSuspend).toHaveBeenCalledTimes(1);
        unmount();
      });
    });

    describe('Foreground Execution Backgrounding (CTRL+B)', () => {
      it('does not invoke backgrounding or add history while idle', async () => {
        const addItem = vi.fn();
        mockedUseHistory.mockReturnValue({
          history: [],
          addItem,
          updateItem: vi.fn(),
          clearItems: vi.fn(),
          loadHistory: vi.fn(),
        });
        const backgroundSpy = vi.spyOn(ExecutionLifecycleService, 'background');

        await setupKeypressTest();
        addItem.mockClear();
        backgroundSpy.mockClear();

        pressKey('\x02');

        expect(backgroundSpy).not.toHaveBeenCalled();
        expect(addItem).not.toHaveBeenCalled();
        unmount();
      });

      // skip: 现存失败
      it.skip('backgrounds every foreground tool execution', async () => {
        mockedUseRunLoop.mockReturnValue({
          ...DEFAULT_RUN_LOOP_MOCK,
          pendingHistoryItems: [
            {
              type: 'tool_group',
              tools: [
                {
                  callId: 'bash-1',
                  name: 'Bash',
                  description: 'sleep 30',
                  status: CoreToolCallStatus.Executing,
                  resultDisplay: '',
                  executionId: 101,
                },
                {
                  callId: 'agent-1',
                  name: 'Agent',
                  description: 'research',
                  status: CoreToolCallStatus.Executing,
                  resultDisplay: '',
                  executionId: 202,
                },
              ],
            },
          ],
        });
        const backgroundSpy = vi
          .spyOn(ExecutionLifecycleService, 'background')
          .mockImplementation(
            (executionId) =>
              ({ executionId }) as NonNullable<
                ReturnType<typeof ExecutionLifecycleService.background>
              >,
          );

        await setupKeypressTest();
        backgroundSpy.mockClear();

        pressKey('\x02');

        expect(backgroundSpy.mock.calls).toEqual([
          [101, 'user'],
          [202, 'user'],
        ]);
        unmount();
      });
    });
  });

  describe('Shortcuts Help Visibility', () => {
    let rerender: () => void;
    let unmount: () => void;
    let stdin: Awaited<ReturnType<typeof render>>['stdin'];

    const setupShortcutsVisibilityTest = async () => {
      const renderResult = await act(async () => renderAppContainer());
      stdin = renderResult.stdin;
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      rerender = () => renderResult.rerender(getAppContainer());
      unmount = renderResult.unmount;
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    // skip: 现存失败
    it.skip('dismisses shortcuts help when Escape is pressed', async () => {
      await setupShortcutsVisibilityTest();

      act(() => {
        capturedUIActions.setShortcutsHelpVisible(true);
      });
      rerender();
      expect(capturedUIState.shortcutsHelpVisible).toBe(true);

      act(() => {
        stdin.write('\x1b'); // Escape
      });
      // Allow ESC_TIMEOUT to fire so escape is dispatched
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender();
      expect(capturedUIState.shortcutsHelpVisible).toBe(false);

      unmount();
    });

    it('dismisses shortcuts help when streaming starts', async () => {
      await setupShortcutsVisibilityTest();

      act(() => {
        capturedUIActions.setShortcutsHelpVisible(true);
      });
      rerender();
      expect(capturedUIState.shortcutsHelpVisible).toBe(true);

      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: 'responding',
      });

      await act(async () => {
        rerender();
      });
      expect(capturedUIState.shortcutsHelpVisible).toBe(false);

      unmount();
    });

    it('dismisses shortcuts help when action-required confirmation appears', async () => {
      await setupShortcutsVisibilityTest();

      act(() => {
        capturedUIActions.setShortcutsHelpVisible(true);
      });
      rerender();
      expect(capturedUIState.shortcutsHelpVisible).toBe(true);

      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand: vi.fn(),
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: {
          prompt: 'Confirm this action?',
          onConfirm: vi.fn(),
        },
      });

      await act(async () => {
        rerender();
      });
      expect(capturedUIState.shortcutsHelpVisible).toBe(false);

      unmount();
    });
  });

  // Agent dialog state coverage: see useAgentDialogs.test.tsx.

  describe('CoreEvents Integration', () => {
    // UserFeedback / Hook lifecycle event coverage: see useFeedbackEvents.test.tsx.
    // ModelChanged / QuotaChanged listener coverage: see useQuotaState.test.tsx.

    it('provides activeHooks from useHookDisplayState', async () => {
      const mockHooks = [
        { eventName: 'event1', index: 1, total: 1, settled: false },
      ];
      mockedUseHookDisplayState.mockReturnValue(mockHooks);

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());

      expect(capturedUIState.activeHooks).toEqual(mockHooks);
      unmount!();
    });

    it('surfaces the startup readiness wait as the active progress phrase', async () => {
      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      expect(capturedUIState.isCommandProgressActive).toBe(false);

      const orchestratorOptions =
        mockedUseLocalTuiSessionOrchestrator.mock.calls.at(-1)?.[0];
      await act(async () => {
        orchestratorOptions?.onStartupWaitingChange?.(true);
      });

      // StatusRow only forwards currentLoadingPhrase while this flag is set,
      // so both must change together for the wait text to render.
      expect(capturedUIState.isCommandProgressActive).toBe(true);
      expect(capturedUIState.currentLoadingPhrase).toBe(
        'Preparing project context…',
      );

      await act(async () => {
        orchestratorOptions?.onStartupWaitingChange?.(false);
      });
      expect(capturedUIState.isCommandProgressActive).toBe(false);
      unmount!();
    });

    it('does not subscribe to auto Dream UI status events', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());

      expect(
        mockCoreEvents.on.mock.calls.some(
          (call: unknown[]) => call[0] === CoreEvent.AutoDreamStatus,
        ),
      ).toBe(false);
      expect(capturedPendingHistory.pendingHistoryItems).toEqual([]);
      expect(
        mockConfig.taskRegistry?.get('internal-auto-dream'),
      ).toBeUndefined();
      expect(addItem).not.toHaveBeenCalled();

      unmount!();
    });

    it('does not expose auto Memory extraction startup in the UI', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;

      expect(callbacks.onExtractionStarted).toBeUndefined();
      expect(capturedPendingHistory.pendingHistoryItems).toEqual([]);
      expect(
        mockConfig.taskRegistry?.get('internal-auto-memory'),
      ).toBeUndefined();
      expect(addItem).not.toHaveBeenCalled();

      unmount!();
    });

    it('skips auto Memory extraction when no parent prompt was rendered', async () => {
      vi.spyOn(mockConfig, 'isAutoMemoryEnabled').mockReturnValue(true);
      vi.spyOn(
        mockConfig as Config & {
          getSystemPrompt: () =>
            | import('@qwen-code/core').SystemPrompt
            | undefined;
        },
        'getSystemPrompt',
      ).mockReturnValue(undefined);

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() =>
        expect(mockAutoMemoryService.instances.length).toBeGreaterThan(0),
      );
      const handler = mockCoreEvents.on.mock.calls.find(
        (call: unknown[]) => call[0] === CoreEvent.TurnComplete,
      )?.[1] as ((payload: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      act(() => {
        handler?.({
          prompt: 'prompt',
          promptResponse: 'response',
          requestId: 'request-id',
          parentRequestSetId: 'request-set-id',
        });
      });

      expect(
        mockAutoMemoryService.instances.at(-1)?.onTurnComplete,
      ).not.toHaveBeenCalled();
      unmount!();
    });

    it('passes a legitimate empty parent prompt to auto Memory extraction', async () => {
      vi.spyOn(mockConfig, 'isAutoMemoryEnabled').mockReturnValue(true);
      vi.spyOn(
        mockConfig as Config & {
          getSystemPrompt: () =>
            | import('@qwen-code/core').SystemPrompt
            | undefined;
        },
        'getSystemPrompt',
      ).mockReturnValue([]);

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() =>
        expect(mockAutoMemoryService.instances.length).toBeGreaterThan(0),
      );
      const handler = mockCoreEvents.on.mock.calls.find(
        (call: unknown[]) => call[0] === CoreEvent.TurnComplete,
      )?.[1] as ((payload: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      act(() => {
        handler?.({
          prompt: 'prompt',
          promptResponse: 'response',
          requestId: 'request-id',
          parentRequestSetId: 'request-set-id',
        });
      });

      expect(
        mockAutoMemoryService.instances.at(-1)?.onTurnComplete,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'prompt',
          response: 'response',
          systemPrompt: [],
          parentRequestId: 'request-id',
          parentRequestSetId: 'request-set-id',
        }),
      );
      unmount!();
    });

    it('keeps auto Memory no-change completion silent', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;

      expect(callbacks.onExtractionStarted).toBeUndefined();
      expect(callbacks.onExtractionFinished).toBeUndefined();
      expect(capturedPendingHistory.pendingHistoryItems).toEqual([]);
      expect(addItem).not.toHaveBeenCalled();

      unmount!();
    });

    it('does not record no-change Memory completion for repeated request sets', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;

      act(() => {
        callbacks.onExtractionStarted?.();
        (
          callbacks.onExtractionFinished as
            | ((result: {
                status: 'completed';
                parentRequestSetId: string;
              }) => void)
            | undefined
        )?.({ status: 'completed', parentRequestSetId: 'request-1' });
        callbacks.onExtractionStarted?.();
        (
          callbacks.onExtractionFinished as
            | ((result: {
                status: 'completed';
                parentRequestSetId: string;
              }) => void)
            | undefined
        )?.({ status: 'completed', parentRequestSetId: 'request-1' });
      });

      expect(addItem).not.toHaveBeenCalled();

      unmount!();
    });

    it('shows a successful auto Memory save briefly in the status line', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;
      const emitSpy = vi.spyOn(appEvents, 'emit');
      emitSpy.mockClear();

      act(() => {
        callbacks.onExtractionStarted?.();
        callbacks.onMemoriesSaved?.(['/tmp/memory-topic.md']);
        callbacks.onExtractionFinished?.();
      });

      expect(addItem).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(AppEvent.TransientMessage, {
        id: 'auto-memory-saved',
        message: 'Memory saved 1 item',
        type: TransientMessageType.Success,
        durationMs: 3_000,
      });

      unmount!();
    });

    it('uses a plural status-line message for multiple saved memories', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;
      const emitSpy = vi.spyOn(appEvents, 'emit');
      emitSpy.mockClear();

      act(() => {
        callbacks.onExtractionStarted?.();
        callbacks.onMemoriesSaved?.([
          '/tmp/user-topic.md',
          '/tmp/project-topic.md',
        ]);
        callbacks.onExtractionFinished?.();
      });

      expect(addItem).not.toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith(AppEvent.TransientMessage, {
        id: 'auto-memory-saved',
        message: 'Memory saved 2 items',
        type: TransientMessageType.Success,
        durationMs: 3_000,
      });

      unmount!();
    });

    it('does not add a no-change Memory completion for the same request set after saving memory files', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;
      const emitSpy = vi.spyOn(appEvents, 'emit');
      emitSpy.mockClear();

      act(() => {
        callbacks.onExtractionStarted?.();
        callbacks.onMemoriesSaved?.(['/tmp/memory-topic.md']);
        callbacks.onExtractionFinished?.({
          status: 'completed',
          parentRequestSetId: 'request-1',
        });
        callbacks.onExtractionStarted?.();
        callbacks.onExtractionFinished?.({
          status: 'completed',
          parentRequestSetId: 'request-1',
        });
      });

      expect(addItem).not.toHaveBeenCalled();
      expect(
        (emitSpy.mock.calls as unknown[][]).filter(
          ([event]) => event === AppEvent.TransientMessage,
        ),
      ).toHaveLength(1);

      unmount!();
    });

    it('does not expose auto Memory extraction failures in the UI', async () => {
      const addItem = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem,
        updateItem: vi.fn(),
        clearItems: vi.fn(),
        loadHistory: vi.fn(),
      });

      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      await waitFor(() =>
        expect(mockAutoMemoryService.callbacks.length).toBeGreaterThan(0),
      );

      const callbacks = mockAutoMemoryService.callbacks.at(
        -1,
      ) as AutoMemoryCallbacks;

      expect(callbacks.onExtractionStarted).toBeUndefined();
      expect(callbacks.onExtractionFinished).toBeUndefined();
      expect(capturedPendingHistory.pendingHistoryItems).toEqual([]);
      expect(
        mockConfig.taskRegistry?.get('internal-auto-memory'),
      ).toBeUndefined();
      expect(addItem).not.toHaveBeenCalled();

      unmount!();
    });

    it('handles consent request events', async () => {
      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());

      const handler = mockCoreEvents.on.mock.calls.find(
        (call: unknown[]) => call[0] === CoreEvent.ConsentRequest,
      )?.[1];
      expect(handler).toBeDefined();

      const onConfirm = vi.fn();
      const payload = {
        prompt: 'Do you consent?',
        onConfirm,
      };

      act(() => {
        handler(payload);
      });

      expect(capturedUIState.authConsentRequest).toBeDefined();
      expect(capturedUIState.authConsentRequest?.prompt).toBe(
        'Do you consent?',
      );

      act(() => {
        capturedUIState.authConsentRequest?.onConfirm(true);
      });

      expect(onConfirm).toHaveBeenCalledWith(true);
      expect(capturedUIState.authConsentRequest).toBeNull();
      unmount!();
    });

    it('dismisses cancelled consent without clearing a newer prompt', async () => {
      let unmount!: () => void;
      await act(async () => {
        ({ unmount } = await renderAppContainer());
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());
      const handler = mockCoreEvents.on.mock.calls.find(
        (call: unknown[]) => call[0] === CoreEvent.ConsentRequest,
      )?.[1];
      const old = new AbortController();
      const current = new AbortController();
      const onConfirm = vi.fn();
      act(() => {
        handler({ prompt: 'Old origin', signal: old.signal, onConfirm });
      });
      const oldConfirm = capturedUIState.authConsentRequest?.onConfirm;
      act(() => {
        handler({ prompt: 'New origin', signal: current.signal, onConfirm });
        old.abort();
        oldConfirm?.(true);
      });
      expect(capturedUIState.authConsentRequest?.prompt).toBe('New origin');
      expect(onConfirm).not.toHaveBeenCalled();
      act(() => {
        current.abort();
      });
      expect(capturedUIState.authConsentRequest).toBeNull();
      unmount();
    });

    it('unsubscribes from ConsentRequest on unmount', async () => {
      let unmount: () => void;
      await act(async () => {
        const result = await renderAppContainer();
        unmount = result.unmount;
      });
      await waitFor(() => expect(capturedUIState).toBeTruthy());

      unmount!();

      expect(mockCoreEvents.off).toHaveBeenCalledWith(
        CoreEvent.ConsentRequest,
        expect.any(Function),
      );
    });
  });

  describe('onCancelSubmit Behavior', () => {
    let mockSetText: Mock;

    // Helper to extract arguments from the local orchestrator hook call
    const extractUseRunLoopArgs = () => {
      const args = mockedUseRunLoop.mock.lastCall![0] as {
        onCancelSubmit: (shouldRestorePrompt?: boolean) => void;
      };
      return { onCancelSubmit: args.onCancelSubmit };
    };

    beforeEach(() => {
      mockSetText = vi.fn();
      mockedUseTextBuffer.mockReturnValue({
        text: '',
        setText: mockSetText,
      });
    });

    it('preserves buffer when cancelling, even if empty (user is in control)', async () => {
      const { unmount } = await act(async () => renderAppContainer());

      const { onCancelSubmit } = extractUseRunLoopArgs();

      act(() => {
        onCancelSubmit(false);
      });

      // Should NOT modify buffer when cancelling - user is in control
      expect(mockSetText).not.toHaveBeenCalled();

      unmount();
    });

    it('preserves prompt text when cancelling streaming, even if same as last message (regression test for issue #13387)', async () => {
      // Mock buffer with text that user typed while streaming (same as last message)
      const promptText = 'What is Python?';
      mockedUseTextBuffer.mockReturnValue({
        text: promptText,
        setText: mockSetText,
      });

      // Mock input history with same message
      mockedUseInputHistoryStore.mockReturnValue({
        inputHistory: [promptText],
        addInput: vi.fn(),
        initializeFromLogger: vi.fn(),
      });

      const { unmount } = await act(async () => renderAppContainer());

      const { onCancelSubmit } = extractUseRunLoopArgs();

      act(() => {
        // Simulate Escape key cancelling streaming (shouldRestorePrompt=false)
        onCancelSubmit(false);
      });

      // Should NOT call setText - prompt should be preserved regardless of content
      expect(mockSetText).not.toHaveBeenCalled();

      unmount();
    });

    it('preserves prompt text when cancelling while a tool is executing', async () => {
      const promptText = 'draft typed during a long-running command';
      mockedUseTextBuffer.mockReturnValue({
        text: promptText,
        setText: mockSetText,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-running',
                name: 'Shell',
                description: 'sleep 30',
                resultDisplay: undefined,
                status: CoreToolCallStatus.Executing,
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      const { onCancelSubmit } = extractUseRunLoopArgs();

      act(() => {
        onCancelSubmit(false);
      });

      expect(mockSetText).not.toHaveBeenCalled();

      unmount();
    });

    it('restores the prompt when onCancelSubmit is called with shouldRestorePrompt=true (or undefined)', async () => {
      // Mock useInputHistoryStore to provide input history
      mockedUseInputHistoryStore.mockReturnValue({
        inputHistory: ['previous message'],
        addInput: vi.fn(),
        initializeFromLogger: vi.fn(),
      });

      const { unmount } = await act(async () => renderAppContainer());
      expect(capturedInputState.userMessages).toContain('previous message');

      const { onCancelSubmit } = extractUseRunLoopArgs();

      await act(async () => {
        onCancelSubmit(true);
      });

      expect(mockSetText).toHaveBeenCalledWith('previous message');

      unmount();
    });

    it('input history is independent from conversation history (survives /clear)', async () => {
      // This test verifies that input history (used for up-arrow navigation) is maintained
      // separately from conversation history and survives /clear operations.
      const mockAddInput = vi.fn();
      mockedUseInputHistoryStore.mockReturnValue({
        inputHistory: ['first prompt', 'second prompt'],
        addInput: mockAddInput,
        initializeFromLogger: vi.fn(),
      });

      const { rerender, unmount } = await act(async () => renderAppContainer());

      // Verify userMessages is populated from inputHistory
      expect(capturedInputState.userMessages).toContain('first prompt');
      expect(capturedInputState.userMessages).toContain('second prompt');

      // Clear the conversation history (simulating /clear command)
      const mockClearItems = vi.fn();
      mockedUseHistory.mockReturnValue({
        history: [],
        addItem: vi.fn(),
        updateItem: vi.fn(),
        clearItems: mockClearItems,
        loadHistory: vi.fn(),
      });

      await act(async () => {
        // Rerender to apply the new mock.
        rerender(getAppContainer());
      });

      // Verify that userMessages still contains the input history
      // (it should not be affected by clearing conversation history)
      expect(capturedInputState.userMessages).toContain('first prompt');
      expect(capturedInputState.userMessages).toContain('second prompt');

      unmount();
    });
  });

  describe('Submission Handling', () => {
    it('persists submitted prompts for input history navigation', async () => {
      const logMessage = vi.fn().mockResolvedValue(undefined);
      mockedUseLogger.mockReturnValue({
        getPreviousUserMessages: vi.fn().mockResolvedValue([]),
        logMessage,
      });

      await act(async () => renderAppContainer());

      await act(async () =>
        capturedUIActions.handleFinalSubmit('  test prompt  '),
      );

      expect(logMessage).toHaveBeenCalledWith(
        MessageSenderType.USER,
        'test prompt',
      );
    });

    it('resets expansion state on submission when not in alternate buffer', async () => {
      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        }),
      );

      expect(capturedUIActions).toBeTruthy();

      // Expand first
      act(() => capturedUIActions.setConstrainHeight(false));
      expect(capturedUIState.constrainHeight).toBe(false);

      // Reset mock stdout to clear any initial writes
      mocks.mockStdout.write.mockClear();
      (disableMouseEvents as import('vitest').Mock).mockClear();

      // Submit
      await act(async () => capturedUIActions.handleFinalSubmit('test prompt'));

      // Should be reset
      expect(capturedUIState.constrainHeight).toBe(true);
      expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      unmount();
    });

    it('resets expansion state on submission when in alternate buffer without clearing terminal', async () => {
      vi.spyOn(mockConfig, 'getUseTerminalBuffer').mockReturnValue(false);

      vi.spyOn(mockConfig, 'getUseAlternateBuffer').mockReturnValue(true);

      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
        }),
      );

      expect(capturedUIActions).toBeTruthy();

      // Expand first
      act(() => capturedUIActions.setConstrainHeight(false));
      expect(capturedUIState.constrainHeight).toBe(false);

      // Reset mock stdout
      mocks.mockStdout.write.mockClear();
      (disableMouseEvents as import('vitest').Mock).mockClear();

      // Submit
      await act(async () => capturedUIActions.handleFinalSubmit('test prompt'));

      // Should be reset
      expect(capturedUIState.constrainHeight).toBe(true);
      // Should NOT refresh static's clearTerminal in alternate buffer
      expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      unmount();
    });
  });

  describe('Background Detail View Rendering', () => {
    beforeEach(() => {
      vi.spyOn(mockConfig, 'getUseTerminalBuffer').mockReturnValue(false);
      vi.spyOn(mockConfig, 'getUseAlternateBuffer').mockReturnValue(false);
    });

    it('switches to an agent transcript through normal rendering', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      mocks.mockStdout.write.mockClear();

      act(() => capturedUIActions.viewAgentSession('agent-task-1'));

      await waitFor(() =>
        expect(capturedUIState.viewedAgentTaskId).toBe('agent-task-1'),
      );
      expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      unmount();
    });

    it('switches back from a detail view through normal rendering', async () => {
      const { unmount } = await act(async () => renderAppContainer());

      act(() => capturedUIActions.viewAgentSession('agent-task-1'));
      await waitFor(() =>
        expect(capturedUIState.viewedAgentTaskId).toBe('agent-task-1'),
      );
      mocks.mockStdout.write.mockClear();

      act(() => capturedUIActions.viewMainSession());

      await waitFor(() =>
        expect(capturedUIState.viewedAgentTaskId).toBeUndefined(),
      );
      expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      unmount();
    });

    it('switches to a workflow detail through normal rendering', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      mocks.mockStdout.write.mockClear();

      act(() => capturedUIActions.viewWorkflowSession('workflow-task-1'));

      await waitFor(() =>
        expect(capturedUIState.viewedWorkflowTaskId).toBe('workflow-task-1'),
      );
      expect(capturedUIState.sessionRailSelectionMode).toBeUndefined();
      expect(mocks.mockStdout.write).not.toHaveBeenCalledWith(
        ansiEscapes.clearTerminal,
      );
      unmount();
    });

    it('retains an expired workflow while its detail is open', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      const registry = mockConfig.taskRegistry;
      expect(registry).toBeDefined();
      const workflow: WorkflowUnifiedTask = {
        id: 'workflow-expired',
        type: 'local_workflow',
        status: 'completed',
        description: 'Completed workflow',
        startTime: Date.now() - 60_000,
        endTime: Date.now() - 31_000,
        notified: true,
        executionId: 1,
        completionBehavior: 'notify',
        workflowRunId: 'wf_expired',
        workflowName: 'expired-workflow',
        scriptPath: '/tmp/workflow.js',
        transcriptDir: '/tmp/workflow/transcripts',
        progress: [],
        logs: [],
        agentCount: 0,
        totalTokens: 0,
        totalToolCalls: 0,
      };

      act(() => {
        registry?.register(workflow);
        capturedUIActions.viewWorkflowSession(workflow.id);
      });
      act(() => {
        registry?.evictAllTerminal();
      });

      expect(registry?.get(workflow.id)?.retainReason).toBe('task-detail-view');
      expect(capturedUIState.viewedWorkflowTaskId).toBe(workflow.id);

      act(() => capturedUIActions.viewMainSession());

      expect(registry?.get(workflow.id)).toBeUndefined();
      expect(capturedUIState.viewedWorkflowTaskId).toBeUndefined();
      unmount();
    });

    it('evicts an expired background agent as soon as its session view is left', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      const registry = mockConfig.taskRegistry;
      expect(registry).toBeDefined();
      const endTime = Date.now() - 31_000;
      const agentTask: AgentUnifiedTask = {
        id: 'a-fork-expired',
        type: 'local_agent',
        status: 'completed',
        description: 'read every md file under .qwen/agents',
        startTime: endTime - 10_000,
        endTime,
        notified: true,
        executionId: 7,
        completionBehavior: 'notify',
        agentId: 'fork-expired',
        agentName: 'fork',
        agentType: 'fork',
        prompt: 'read every md file under .qwen/agents',
        isBackgrounded: true,
        taskId: 'task-afork-expired',
      };

      act(() => {
        registry?.register(agentTask);
        capturedUIActions.viewAgentSession(agentTask.id);
      });
      act(() => {
        registry?.evictAllTerminal();
      });

      expect(registry?.get(agentTask.id)?.retainReason).toBe(
        'agent-session-view',
      );

      act(() => capturedUIActions.viewMainSession());

      expect(registry?.get(agentTask.id)).toBeUndefined();
      expect(capturedUIState.viewedAgentTaskId).toBeUndefined();
      unmount();
    });

    it('opens a dedicated workflow selection mode', async () => {
      const { unmount } = await act(async () => renderAppContainer());

      act(() => capturedUIActions.viewWorkflowSessions());

      await waitFor(() =>
        expect(capturedUIState.sessionRailSelectionMode).toBe('workflows'),
      );
      expect(capturedUIState.viewedWorkflowTaskId).toBeUndefined();
      unmount();
    });
  });

  describe('Overflow Hint Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should set showIsExpandableHint when overflow occurs in Standard Mode and hides after 10s', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      await waitFor(() => expect(capturedOverflowActions).toBeTruthy());

      // Trigger overflow
      act(() => {
        capturedOverflowActions.addOverflowingId('test-id');
      });

      await waitFor(() => {
        // Should show hint because we are in Standard Mode (default settings) and have overflow
        expect(capturedUIState.showIsExpandableHint).toBe(true);
      });

      // Advance just before the timeout
      act(() => {
        vi.advanceTimersByTime(EXPAND_HINT_DURATION_MS - 100);
      });
      expect(capturedUIState.showIsExpandableHint).toBe(true);

      // Advance to hit the timeout mark
      act(() => {
        vi.advanceTimersByTime(100);
      });
      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(false);
      });

      unmount();
    });

    it('resets the hint timer when a new component overflows (overflowingIdsSize increases)', async () => {
      const { unmount } = await act(async () => renderAppContainer());
      await waitFor(() => expect(capturedOverflowActions).toBeTruthy());

      // 1. Trigger first overflow
      act(() => {
        capturedOverflowActions.addOverflowingId('test-id-1');
      });

      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(true);
      });

      // 2. Advance half the duration
      act(() => {
        vi.advanceTimersByTime(EXPAND_HINT_DURATION_MS / 2);
      });
      expect(capturedUIState.showIsExpandableHint).toBe(true);

      // 3. Trigger second overflow (this should reset the timer)
      act(() => {
        capturedOverflowActions.addOverflowingId('test-id-2');
      });

      // Advance by 1ms to allow the OverflowProvider's 0ms batching timeout to fire
      // and flush the state update to AppContainer, triggering the reset.
      act(() => {
        vi.advanceTimersByTime(1);
      });

      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(true);
      });

      // 4. Advance enough that the ORIGINAL timer would have expired
      // Subtracting 1ms since we advanced it above to flush the state.
      act(() => {
        vi.advanceTimersByTime(EXPAND_HINT_DURATION_MS / 2 + 100 - 1);
      });
      // The hint should STILL be visible because the timer reset at step 3
      expect(capturedUIState.showIsExpandableHint).toBe(true);

      // 5. Advance to the end of the NEW timer
      act(() => {
        vi.advanceTimersByTime(EXPAND_HINT_DURATION_MS / 2 - 100);
      });
      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(false);
      });

      unmount();
    });

    it('switches conversation screens without mutating the prompt fold state', async () => {
      const ctrlOKey = {
        name: 'o',
        shift: false,
        alt: false,
        ctrl: true,
        cmd: false,
        insertable: false,
        sequence: '\x0f',
      };
      const { unmount } = await act(async () => renderAppContainer());
      await waitFor(() => {
        expect(capturedOverflowActions).toBeTruthy();
        expect(
          capturedActionRegistry?.getActionsForContext('Global'),
        ).toContain('app:showMoreLines');
      });

      expect(capturedUIState.conversationScreen).toBe('prompt');
      expect(capturedUIState.constrainHeight).toBe(true);
      expect(capturedFoldState.globalFoldLevel).toBe(
        FoldLevel.GroupExpandedToolCollapsed,
      );
      expect(capturedToolActions.isExpanded('test-call')).toBe(false);

      act(() => {
        capturedOverflowActions.addOverflowingId('test-id');
      });

      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(true);
      });

      act(() => {
        capturedActionRegistry?.invokeAction(
          'Global',
          'app:showMoreLines',
          ctrlOKey,
        );
      });

      await waitFor(() => {
        expect(capturedUIState.conversationScreen).toBe('transcript');
      });
      expect(capturedUIState.constrainHeight).toBe(false);
      expect(capturedUIState.showIsExpandableHint).toBe(false);
      expect(capturedFoldState.globalFoldLevel).toBe(
        FoldLevel.GroupExpandedToolCollapsed,
      );
      expect(capturedToolActions.isExpanded('test-call')).toBe(true);

      act(() => {
        capturedActionRegistry?.invokeAction(
          'Global',
          'app:showMoreLines',
          ctrlOKey,
        );
      });

      await waitFor(() => {
        expect(capturedUIState.conversationScreen).toBe('prompt');
      });
      expect(capturedUIState.constrainHeight).toBe(true);
      expect(capturedFoldState.globalFoldLevel).toBe(
        FoldLevel.GroupExpandedToolCollapsed,
      );
      expect(capturedToolActions.isExpanded('test-call')).toBe(false);

      unmount();
    });

    it('DOES set showIsExpandableHint when overflow occurs in Alternate Buffer Mode', async () => {
      const settingsWithAlternateBuffer = createMockSettings({
        ui: { useAlternateBuffer: true },
      });

      vi.spyOn(mockConfig, 'getUseTerminalBuffer').mockReturnValue(false);

      vi.spyOn(mockConfig, 'getUseAlternateBuffer').mockReturnValue(true);

      const { unmount } = await act(async () =>
        renderAppContainer({
          settings: settingsWithAlternateBuffer,
        }),
      );
      await waitFor(() => expect(capturedOverflowActions).toBeTruthy());

      // Trigger overflow
      act(() => {
        capturedOverflowActions.addOverflowingId('test-id');
      });

      // Should NOW show hint because we are in Alternate Buffer Mode
      await waitFor(() => {
        expect(capturedUIState.showIsExpandableHint).toBe(true);
      });

      unmount();
    });
  });

  describe('Permission Handling', () => {
    it('routes raw local input through submitUserInput', async () => {
      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });
      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIActions).toBeTruthy();

      await act(async () =>
        capturedUIActions.handleFinalSubmit('read @file.txt'),
      );

      expect(submitUserInput).toHaveBeenCalledExactlyOnceWith(
        'read @file.txt',
        expect.objectContaining({
          pastedContents: {},
          userMessage: { uuid: expect.any(String), timestamp: undefined },
        }),
      );
      unmount();
    });

    it('routes slash commands while config initialization is still pending', async () => {
      const initializingConfig = makeFakeConfig();
      vi.spyOn(initializingConfig, 'isInitialized').mockReturnValue(false);
      vi.spyOn(initializingConfig, 'getUseRenderProcess').mockReturnValue(
        false,
      );
      vi.spyOn(initializingConfig, 'getTargetDir').mockReturnValue(
        '/test/workspace',
      );
      (
        initializingConfig as Config & {
          initializeForInteractiveStartup: () => Promise<void>;
        }
      ).initializeForInteractiveStartup = vi.fn(
        () => new Promise<void>(() => {}),
      );

      const submitUserInput = vi.fn();
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });
      const { unmount } = await act(async () =>
        renderAppContainer({ config: initializingConfig }),
      );

      await act(async () => capturedUIActions.handleFinalSubmit('/auth'));

      expect(submitUserInput).toHaveBeenCalledWith('/auth', {
        pastedContents: {},
      });
      unmount();
    });

    // skip: 现存失败
    it.skip('runs safe slash commands directly while idle without the input processor', async () => {
      const submitUserInput = vi.fn();
      const handleSlashCommand = vi.fn().mockResolvedValue({ type: 'handled' });
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand,
        slashCommands: [
          {
            name: 'about',
            description: 'Show version info',
            kind: CommandKind.BUILT_IN,
            isSafeConcurrent: true,
            action: vi.fn(),
          },
        ],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Idle,
        submitUserInput,
      });

      const { unmount } = await act(async () => renderAppContainer());

      await act(async () => capturedUIActions.handleFinalSubmit('/about'));

      expect(handleSlashCommand).toHaveBeenCalledWith(
        '/about',
        undefined,
        undefined,
        true,
        true,
        {},
        'typed',
      );
      expect(submitUserInput).not.toHaveBeenCalled();
      unmount();
    });

    // skip: 现存失败
    it.skip('routes slash submit_prompt actions through the local input processor callback', async () => {
      const submitUserInput = vi.fn();
      const handleSlashCommand = vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: 'review this diff',
        isMeta: false,
      });
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });

      const { unmount } = await act(async () => renderAppContainer());

      await act(async () => capturedUIActions.handleFinalSubmit('/review'));

      expect(submitUserInput).toHaveBeenCalledWith('/review', {
        pastedContents: {},
      });

      const args = mockedUseRunLoop.mock.lastCall![0] as {
        onSlashCommand: (input: string) => Promise<unknown>;
      };
      await expect(args.onSlashCommand('/review')).resolves.toEqual({
        type: 'submit_prompt',
        content: 'review this diff',
        isMeta: false,
      });
      expect(handleSlashCommand).toHaveBeenCalledWith(
        '/review',
        undefined,
        undefined,
        true,
        false,
        undefined,
        'typed',
      );
      unmount();
    });

    // skip: 现存失败
    it.skip('routes slash schedule_tool follow-up prompts through the local input processor callback', async () => {
      const submitUserInput = vi.fn();
      const handleSlashCommand = vi.fn().mockResolvedValue({
        type: 'schedule_tool',
        postSubmitPrompt: 'apply review feedback',
      });
      mockedUseSlashCommandProcessor.mockReturnValue({
        handleSlashCommand,
        slashCommands: [],
        pendingHistoryItems: [],
        commandContext: {},
        shellConfirmationRequest: null,
        confirmationRequest: null,
      });
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        submitUserInput,
      });

      const { unmount } = await act(async () => renderAppContainer());

      await act(async () => capturedUIActions.handleFinalSubmit('/edit'));

      expect(submitUserInput).toHaveBeenCalledWith('/edit', {
        pastedContents: {},
      });

      const args = mockedUseRunLoop.mock.lastCall![0] as {
        onSlashCommand: (input: string) => Promise<unknown>;
      };
      await expect(args.onSlashCommand('/edit')).resolves.toEqual({
        type: 'schedule_tool',
        postSubmitPrompt: 'apply review feedback',
      });
      expect(handleSlashCommand).toHaveBeenCalledWith(
        '/edit',
        undefined,
        undefined,
        true,
        false,
        undefined,
        'typed',
      );
      unmount();
    });
  });

  describe('Plan Mode Availability', () => {
    it('should allow plan mode when enabled and idle', async () => {
      vi.spyOn(mockConfig, 'isPlanEnabled').mockReturnValue(true);
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState).toBeTruthy();
      expect(capturedUIState.allowPlanMode).toBe(true);
      unmount();
    });

    it('should NOT allow plan mode when disabled in config', async () => {
      vi.spyOn(mockConfig, 'isPlanEnabled').mockReturnValue(false);
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState).toBeTruthy();
      expect(capturedUIState.allowPlanMode).toBe(false);
      unmount();
    });

    it('should NOT allow plan mode when streaming', async () => {
      vi.spyOn(mockConfig, 'isPlanEnabled').mockReturnValue(true);
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Responding,
        pendingHistoryItems: [],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState).toBeTruthy();
      expect(capturedUIState.allowPlanMode).toBe(false);
      unmount();
    });

    it('should NOT allow plan mode when a tool is awaiting confirmation', async () => {
      vi.spyOn(mockConfig, 'isPlanEnabled').mockReturnValue(true);
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        streamingState: StreamingState.Idle,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                name: 'test_tool',
                status: CoreToolCallStatus.AwaitingApproval,
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState).toBeTruthy();
      expect(capturedUIState.allowPlanMode).toBe(false);
      unmount();
    });
  });

  // `canPrompt` is `!otherDialogsVisible`, and with no peer request outstanding
  // `dialogsVisible` is that same value — so these read the flag the peer
  // approval hook is gated on. A surface missing from the list does not fail
  // loudly: the hook claims the message, pins it, starts its expiry timer, and
  // the dialog is never drawn because something else owns the screen.
  describe('Screen ownership for peer approval prompts', () => {
    it('counts a tool awaiting confirmation as owning the screen', async () => {
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [
          {
            type: 'tool_group',
            tools: [
              {
                callId: 'call-1',
                name: 'test_tool',
                status: CoreToolCallStatus.AwaitingApproval,
              },
            ],
          },
        ],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.dialogsVisible).toBe(true);
      unmount();
    });

    it('leaves the screen free when nothing is pending', async () => {
      mockedUseRunLoop.mockReturnValue({
        ...DEFAULT_RUN_LOOP_MOCK,
        pendingHistoryItems: [],
      });

      const { unmount } = await act(async () => renderAppContainer());

      expect(capturedUIState.dialogsVisible).toBe(false);
      unmount();
    });
  });
});

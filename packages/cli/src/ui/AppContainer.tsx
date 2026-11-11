/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppContainerProps } from './AppContainerProps.js';
import { createStartupModelApplier } from '../startup/applyStartupModel.js';
import {
  useMemo,
  useState,
  useReducer,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useContext,
} from 'react';
import {
  type DOMElement,
  Text,
  useApp,
  useStdout,
  useStdin,
  type AppProps,
  AppContext as InkAppContext,
  inkInstances,
  useAfterLayout,
  AFTER_LAYOUT_PRIORITY,
} from 'ink';
import { App } from './App.js';
import { historyDisplay } from './session/sessionDisplayState.js';
import {
  createSessionUiBinding,
  type SessionUiBinding,
} from './session/prepareSessionUi.js';
import { useSession } from './session/useSession.js';
import { createSessionConfig } from './session/sessionConfig.js';
import { AppContext } from './contexts/AppContext.js';
import {
  UIStateContext,
  useUIState,
  type SessionRailSelectionMode,
  type ModelNextActionSuggestions,
  type ConversationScreen,
  type UIState,
} from './contexts/UIStateContext.js';
import { PendingHistoryContext } from './contexts/PendingHistoryContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import { ConfigContext } from './contexts/ConfigContext.js';
import { SessionGateContext } from './contexts/SessionGateContext.js';
import {
  INITIAL_SESSION_GATE,
  OPEN_SESSION_GATE,
  type SessionGateState,
} from './sessionGate.js';
import {
  type HistoryItem,
  type ConfirmationRequest,
  MessageType,
  StreamingState,
  type HistoryItemWithoutId,
  type SlashCommandProcessorResult,
} from './types.js';
import { ToolActionsProvider } from './contexts/ToolActionsContext.js';
import { useOptionalPermissionQueueStore } from './permissions/PermissionQueueContext.js';
import { useOptionalPermissionQueue } from './permissions/usePermissionQueue.js';
import { useFoldState } from './contexts/FoldStateContext.js';
import { MouseProvider } from './contexts/MouseContext.js';
import { ScrollProvider } from './contexts/ScrollProvider.js';
import { FullScreenPanelProvider } from './contexts/FullScreenPanelContext.js';
import { useI18nService } from './i18n/index.js';
import stringWidth from 'string-width';
import { getHookStatusText } from './utils/hookStatusText.js';
import { persistentState } from '../utils/persistentState.js';
import { shouldShowBtwTip } from './utils/btwTip.js';

import {
  getErrorMessage,
  PermissionModeUnavailableError,
  MessageSenderType,
  CoreToolCallStatus,
  runLogger,
  coreEvents,
  CoreEvent,
  flattenMemory,
  disableMouseEvents,
  enableMouseEvents,
  disableLineWrapping,
  shouldEnterAlternateScreen,
  SessionStartSource,
  HookEventName,
  buildUserSteeringHintPrompt,
  AutoMemoryExtractionService,
  getAutoMemoryDir,
  ensureAutoMemoryDir,
  QueryGuard,
  hasCommandsInQueue,
  getCommandQueue,
  getCommandQueueSnapshot,
  getCommandQueueRevision,
  BRAND_CLI_NAME,
  getRewindCandidates,
  formatFileHistoryRewindFailure,
  ConversationRewindError,
  getNextPermissionMode,
  markStartupMilestone,
  sessionLogger,
  createSystemMessage,
  countCronTasksSync,
  createSessionStartupRuntime,
  ownsWorktreeLifecycle,
  TaskRegistry,
  bridgeExecutionLifecycleToRegistry,
  isAgentSessionsEnabled,
  isBashTask,
  isInternalAgentTask,
  isWorkflowTask,
  type EditorType,
  type ExternalEditorPayload,
  type Config,
  type Message,
  type SessionResumeData,
  type ConsentRequestPayload,
  type RewindCandidate,
  type PastedContent,
  type PermissionMode,
  type PendingHookOutput,
  type TurnCompletePayload,
  type QueuedCommand,
  type ProcessInputResult,
} from '@qwen-code/core';
import {
  runAfterConfigInitializedStartup,
} from '../startup/startupCoordinator.js';
import { waitForTuiFirstTurnReady } from '../startup/startupModePolicy.js';
import process from 'node:process';
import { useHistory } from './hooks/useHistoryManager.js';
import { useMemoryMonitor } from './hooks/useMemoryMonitor.js';
import { useMemoryStatus } from './hooks/useMemoryStatus.js';
import { useAgentsMdSizeWarning } from './hooks/useAgentsMdSizeWarning.js';
import { useModelViewState } from './hooks/useModelViewState.js';
import { useSessionRegistryStatus } from './hooks/useSessionRegistryStatus.js';
import { usePendingHints } from './hooks/usePendingHints.js';
import { useUserMessageQueue } from './hooks/useUserMessageQueue.js';
import { useAgentDialogs } from './hooks/useAgentDialogs.js';
import { useBrowserDialogs } from './hooks/useBrowserDialogs.js';
import { useFeedbackEvents } from './hooks/useFeedbackEvents.js';
import { usePeerInboundApproval } from './hooks/usePeerInboundApproval.js';
import {
  shouldEnableMcpAuthHeaderNotice,
  useMcpAuthHeaderNotice,
} from './hooks/useMcpAuthHeaderNotice.js';
import { useCompressionProgress } from './hooks/useCompressionProgress.js';
import { useModelQueueDevScenario } from './hooks/useModelQueueDevScenario.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useCliApplication } from './contexts/CliApplicationContext.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useVimMode } from './contexts/VimModeContext.js';
import {
  useOverflowActions,
  useOverflowState,
} from './contexts/OverflowContext.js';
import { useErrorCount } from './hooks/useConsoleMessages.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { calculatePromptWidths } from './components/InputPrompt.js';
import { calculateMainAreaWidth } from './utils/ui-sizing.js';
import {
  computeTerminalTitle,
  createProvisionalTerminalTitle,
  isWindowsTerminalHost,
  sanitizeTitleText,
} from '../utils/windowTitle.js';
import type { TextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useQueueProcessor } from './hooks/useQueueProcessor.js';
import { useLocalTuiSessionOrchestrator } from './hooks/useLocalTuiSessionOrchestrator.js';
import { useRuntimeProjection } from './hooks/useRuntimeProjection.js';
import type { TrackedToolCall } from './hooks/useToolScheduler.js';
import type { ExternalImportApprovalResult } from './components/ExternalImportApprovalDialog.js';
import { getModelProgressLabel } from './utils/modelProgress.js';
import type {
  BashCommandOutcome,
  ReplaceMessagesFn,
  RunManualCompress,
  RuntimeProjectionController,
  SubmitUserInputOptions,
} from './hooks/localSession.shared.js';
import {
  EMPTY_EXTERNAL_IMPORT_STATE,
  NOOP_RUNTIME_PROJECTION,
} from './hooks/localSession.shared.js';
import { RewindDialog } from './components/RewindDialog.js';
import { convertMessagesToHistoryFormats } from '../utils/sessionUtils.js';

const AUTO_MEMORY_SAVED_STATUS_DURATION_MS = 3_000;
import { useExecutionLifecycle } from './hooks/useExecutionLifecycle.js';
import { useFocus } from './hooks/useFocus.js';
import { type Key } from './hooks/useKeypress.js';
import { useRegisterActionHandlers } from './contexts/ActionHandlerRegistry.js';
import { useContextRouting } from './hooks/useContextRouting.js';
import {
  useAppFocusContextSync,
  useAppFocusMachine,
} from './state/AppFocusContext.js';

import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { shouldShowLoadingIndicator } from './hooks/streamingUtils.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { usePluginStartupChecks } from './hooks/usePluginStartupChecks.js';
import { getPendingProjectMcpServers } from '../config/config.js';
import {
  McpApprovalChoice,
  type McpApprovalResult,
} from './components/McpServerApprovalDialog.js';
import {
  approveProjectMcpServer,
  rejectProjectMcpServer,
  approveAllProjectMcpServers,
} from '../config/mcp/projectMcpApproval.js';
import { appEvents, AppEvent, TransientMessageType } from '../utils/events.js';
import { type UpdateObject } from './utils/updateCheck.js';
import { setUpdateHandler } from '../utils/handleAutoUpdate.js';
import {
  registerCleanup,
  registerExitCancellation,
  gracefulExit,
} from '../utils/cleanup.js';
import type { SessionInfo } from '../utils/sessionUtils.js';
import { useMcpStatus } from './hooks/useMcpStatus.js';
import { usePermissionModeIndicator } from './hooks/usePermissionModeIndicator.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import {
  useConfirmUpdateRequests,
  useExtensionUpdates,
} from './hooks/useExtensionUpdates.js';
import { useSessionBrowser } from './hooks/useSessionBrowser.js';
import { useSessionResume } from './hooks/useSessionResume.js';
import { needsProjectRebuild } from '../interactiveProjectRuntime.js';
import { useIncludeDirsTrust } from './hooks/useIncludeDirsTrust.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';
import { useSettings } from './contexts/SettingsContext.js';
import { terminalCapabilityManager } from './utils/terminalCapabilityManager.js';
import { useInputHistoryStore } from './hooks/useInputHistoryStore.js';
import { useTerminalSetupPrompt } from './utils/terminalSetup.js';
import { useHookDisplayState } from './hooks/useHookDisplayState.js';
import {
  WARNING_PROMPT_DURATION_MS,
  QUEUE_ERROR_DISPLAY_DURATION_MS,
  EXPAND_HINT_DURATION_MS,
} from './constants.js';
import { UnifiedTaskPanel } from './components/UnifiedTaskPanel.js';
import { dismissTask } from './utils/taskActions.js';
import { getBackgroundTaskStatusCount } from './utils/backgroundTaskStatus.js';
import { buildBackgroundAgentWaitingItem } from './utils/backgroundAgentWaiting.js';
import {
  TaskRegistryProvider,
  useTaskRegistry,
} from './contexts/TaskRegistryContext.js';
import { useTaskRegistryState } from './hooks/useTaskRegistryState.js';
import { useWorkflowHistory } from './hooks/useWorkflowHistory.js';
import { isSlashCommand } from './utils/commandUtils.js';
import { parseSlashCommand } from '../utils/commands.js';
import { extractSlashCommandToken } from '../utils/slashCommandToken.js';
import { CommandKind } from './commands/types.js';
import {
  BRIDGE_SAFE_BUILTIN_COMMANDS,
  getBridgeCommandType,
  buildBridgeBlockedDecision,
} from '../utils/bridgeCommandUtils.js';
import { useTerminalTheme } from './hooks/useTerminalTheme.js';
import { useTimedMessage } from './hooks/useTimedMessage.js';
import { useTransientMessage } from './hooks/useTransientMessage.js';
import { useStartupWarningHistory } from './hooks/useStartupWarningHistory.js';

import { useSuspend } from './hooks/useSuspend.js';
import { useRunEventNotifications } from './hooks/useRunEventNotifications.js';
import {
  useObservedTurnEnd,
  useProgramStatus,
} from './hooks/useProgramStatus.js';
import {
  getProgramStatusBlocker,
  toMainProgramStatus,
  toSubagentProgramStatuses,
} from './utils/programStatus.js';
import { isNotificationsEnabled } from '../utils/terminalNotifications.js';
import {
  isToolExecuting,
  isToolAwaitingConfirmation,
  getAllToolCalls,
} from './utils/historyUtils.js';

type InteractiveStartupConfig = Config & {
  initializeForInteractiveStartup?: () => Promise<void>;
  hydrateAfterFirstRender?: () => Promise<void>;
};

/**
 * The pending COMPRESSION item /compact sets via `ui.setPendingItem` is an
 * internal command lock: it keeps the input available for queued follow-ups
 * (`isCompacting`) but its visible state is rendered by
 * CompressionProgressIndicator, so it must be kept out of displayed history.
 */
function isPendingCompactionMarker(item: HistoryItemWithoutId): boolean {
  return (
    item.type === MessageType.COMPRESSION &&
    item.compression?.isPending === true
  );
}

function getUnknownSlashCommandName(
  input: string,
  commands: Parameters<typeof parseSlashCommand>[1],
): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (parseSlashCommand(trimmed, commands).commandToExecute) {
    return null;
  }

  return extractSlashCommandToken(trimmed);
}

function getBridgeSlashCommandDecision(
  input: string,
  commands: Parameters<typeof parseSlashCommand>[1],
): { allow: true } | { allow: false; message: string } | null {
  const parsed = parseSlashCommand(input, commands);
  const command = parsed.commandToExecute;
  if (!command) {
    return null;
  }
  const bridgeCommandType = getBridgeCommandType(command, parsed.args, input);
  if (bridgeCommandType === 'prompt') {
    return { allow: true };
  }
  if (bridgeCommandType === 'local-jsx') {
    return buildBridgeBlockedDecision(command.name);
  }
  if (bridgeCommandType === 'local') {
    return BRIDGE_SAFE_BUILTIN_COMMANDS.has(command.name)
      ? { allow: true }
      : buildBridgeBlockedDecision(command.name);
  }

  if (command.kind !== CommandKind.BUILT_IN) {
    return { allow: true };
  }

  if (BRIDGE_SAFE_BUILTIN_COMMANDS.has(command.name)) {
    return { allow: true };
  }

  return buildBridgeBlockedDecision(command.name);
}

type SessionDisplayTitleSource =
  | 'custom'
  | 'ai'
  | 'provisional'
  | 'initial'
  | 'topic'
  | null;

/** Normalizes a persisted custom title for the prompt border label. */
function toSessionName(raw: string | undefined): string | undefined {
  const cleaned = raw ? sanitizeTitleText(raw) : '';
  return cleaned || undefined;
}

import { useRepeatedKeyPress } from './hooks/useRepeatedKeyPress.js';
import {
  useVisibilityToggle,
  PERMISSION_MODE_REVEAL_DURATION_MS,
} from './hooks/useVisibilityToggle.js';

import { InputStateProvider } from './contexts/InputStateProvider.js';
import { buildTaskNotificationHistoryItem } from './components/messages/TaskNotificationMessage.js';
import { buildTeammateMessageHistoryItem } from './components/messages/TeammateMessage.js';
import { buildPeerMessageHistoryItem } from './components/messages/PeerMessage.js';
import {
  getBypassPermissionsWarning,
  getDontAskWarning,
} from './constants/permissionWarnings.js';

function toStartupInitializationError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(getErrorMessage(error) || 'Config initialization failed');
}

// Stable noops for an externally supplied session —
// hoisted to module scope so they don't bust downstream useMemo deps.
/** Predicate: is this a user-submitted prompt rather than an internal command. */
const isUserPrompt = (cmd: {
  commandMode: string;
  targetAgentId?: string;
  isMeta?: boolean;
  origin?: { kind: string };
}) =>
  cmd.commandMode === 'prompt' &&
  cmd.targetAgentId === undefined &&
  cmd.isMeta !== true &&
  (cmd.origin === undefined || cmd.origin.kind === 'human');

const NOOP_QUEUE_HOOK_CONTEXT = (
  _context: string,
  _hookEventName?: HookEventName,
  _sourceType?: PendingHookOutput['sourceType'],
): void => {};
const NOOP_HANDLE_EXTERNAL_IMPORT_APPROVAL = (
  _result: ExternalImportApprovalResult,
): void => {};

/**
 * Wrapper that reads unified tasks from context so the panel always shows
 * live data. Stored in customDialog state — avoids stale-closure issues
 * that occur when passing tasks as a prop at setCustomDialog() call time.
 */
function LiveUnifiedTaskPanel({
  onClose,
  addInfoItem,
}: {
  onClose: () => void;
  addInfoItem?: (text: string) => void;
}) {
  const uiState = useUIState();
  const registry = useTaskRegistry();
  return (
    <UnifiedTaskPanel
      tasks={uiState.unifiedTasks}
      onClose={onClose}
      onDismissTask={(task) => dismissTask(registry, task, addInfoItem)}
    />
  );
}

export const AppContainer = (props: AppContainerProps) => {
  const {
    config: baseConfig,
    themeError: initialThemeError,
    resumedSessionData,
  } = props;
  const initialSession = props.sessionUi?.session.getState();
  const hasSessionBinding = props.sessionUi !== undefined;
  const application = useCliApplication();
  const config = baseConfig;
  const applyStartupModel = useMemo(
    () => createStartupModelApplier(config.getCliModel()),
    [config],
  );
  const [localSessionBinding, setLocalSessionBinding] = useState<{
    config: Config;
    binding: SessionUiBinding;
  }>();
  const localSession =
    !hasSessionBinding && localSessionBinding?.config === baseConfig
      ? localSessionBinding
      : undefined;
  const sessionUi = props.sessionUi ?? localSession?.binding;
  const hasUiSession = sessionUi !== undefined;
  const settings = useSettings();
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const { locale: uiLocale } = i18n;
  const { reset } = useOverflowActions()!;
  const notificationsEnabled = isNotificationsEnabled(settings);

  const initialHistoryItems = useMemo(
    () =>
      (initialSession?.initialHistory
        ? historyDisplay(initialSession.initialHistory)
        : []
      ).map((item, index) => ({
        ...item,
        id: index + 1,
      })),
    [initialSession?.initialHistory],
  );

  const { setOptions, dumpCurrentFrame } = useContext(InkAppContext);
  const recordSupplementaryHistoryRef = useRef<
    (item: HistoryItemWithoutId) => Promise<void>
  >(async () => {});
  // Stable identity so useHistory's addItem stays referentially stable across
  // renders. An inline arrow here cascades into per-render re-fires of every
  // effect that depends on addItem (e.g. useTerminalSetupPrompt → ps fork).
  const onRecordItem = useCallback(
    (item: HistoryItemWithoutId) => recordSupplementaryHistoryRef.current(item),
    [],
  );
  const historyManager = useHistory({
    initialItems: initialHistoryItems,
    onRecordItem,
  });

  const sessionView = useSession({
    enabled: hasUiSession,
    binding: sessionUi,
    config,
    addHistoryItem: historyManager.addItem,
  });

  const sessionConfigBinding = useRef({
    kind: hasSessionBinding ? ('external' as const) : ('local' as const),
    session: sessionView.sessionHandle!,
    settings: {
      model: sessionView.currentModel,
      reasoningEffort: sessionView.currentReasoningEffort,
      contextWindow: sessionView.currentContextWindow,
      permissionMode: sessionView.currentPermissionMode,
    },
  });
  sessionConfigBinding.current = {
    kind: hasSessionBinding ? ('external' as const) : ('local' as const),
    session: sessionView.sessionHandle!,
    settings: {
      model: sessionView.currentModel,
      reasoningEffort: sessionView.currentReasoningEffort,
      contextWindow: sessionView.currentContextWindow,
      permissionMode: sessionView.currentPermissionMode,
    },
  };
  const addSessionHistoryItem = historyManager.addItem;
  const uiConfig = useMemo(
    () =>
      createSessionConfig(baseConfig, sessionConfigBinding, (text) =>
        addSessionHistoryItem({ type: MessageType.ERROR, text }, Date.now()),
      ),
    [baseConfig, addSessionHistoryItem],
  );

  useMemoryMonitor(historyManager);
  const isAlternateBuffer = config.getUseAlternateBuffer();
  useEffect(() => {
    setOptions?.({
      stickyHeadersInBackbuffer: isAlternateBuffer,
    });
    if (isAlternateBuffer) {
      enableMouseEvents();
    } else {
      disableMouseEvents();
    }
    const unregister = registerCleanup(disableMouseEvents);
    return () => {
      unregister();
      disableMouseEvents();
    };
  }, [isAlternateBuffer, setOptions]);

  const [corgiMode, setCorgiMode] = useState(false);
  const [forceRerenderKey] = useState(0);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const [themeError, setThemeError] = useState<string | null>(
    initialThemeError,
  );
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isStartupWaiting, setIsStartupWaiting] = useState(false);
  // ── Focus state: driven by AppFocusStateMachine ──
  // The state machine is the single source of truth for focus/overlay state.
  // We derive the legacy booleans from the snapshot for backward compatibility
  // during incremental migration of downstream consumers.
  const focusMachine = useAppFocusMachine();
  useAppFocusContextSync(); // syncs machine → KeyboardContextRegistry

  const [showDebugProfiler, setShowDebugProfiler] = useState(false);

  // ── Unified Task Registry ──
  const taskRegistry = useMemo(() => new TaskRegistry(), []);
  useEffect(() => {
    config.taskRegistry = taskRegistry;
    const cleanup = bridgeExecutionLifecycleToRegistry(taskRegistry, {
      config,
    });
    return () => {
      config.taskRegistry = undefined;
      cleanup();
    };
  }, [config, taskRegistry]);
  const { tasks: unifiedTasks } = useTaskRegistryState(taskRegistry);
  const agentSessionsEnabled = isAgentSessionsEnabled();
  const visibleUnifiedTasks = useMemo(
    () =>
      agentSessionsEnabled
        ? unifiedTasks
        : unifiedTasks.filter(
            (task) =>
              isBashTask(task) ||
              isWorkflowTask(task) ||
              isInternalAgentTask(task),
          ),
    [agentSessionsEnabled, unifiedTasks],
  );
  const [viewedAgentTaskId, setViewedAgentTaskId] = useState<
    string | undefined
  >(undefined);
  const [sessionRailSelectionMode, setSessionRailSelectionMode] =
    useState<SessionRailSelectionMode>();
  const [viewedWorkflowTaskId, setViewedWorkflowTaskId] = useState<
    string | undefined
  >(undefined);
  const liveWorkflowTasks = useMemo(
    () => unifiedTasks.filter(isWorkflowTask),
    [unifiedTasks],
  );
  const workflowHistoryTasks = useWorkflowHistory(
    config,
    taskRegistry,
    liveWorkflowTasks,
    sessionRailSelectionMode === 'workflows',
  );

  const releaseTaskView = useCallback(
    (taskId: string) => {
      taskRegistry.update(taskId, { retainReason: undefined });
      // Applies to agent tasks too, not just workflows: once the retain is
      // gone a terminal task that is already past its grace period must leave
      // the rail right away instead of waiting for the next eviction tick.
      taskRegistry.evictTerminal(taskId);
    },
    [taskRegistry],
  );

  useEffect(() => {
    if (agentSessionsEnabled || !viewedAgentTaskId) return;
    releaseTaskView(viewedAgentTaskId);
    setViewedAgentTaskId(undefined);
  }, [agentSessionsEnabled, releaseTaskView, viewedAgentTaskId]);

  useEffect(() => {
    const handleTaskRemoved = (removedTaskId: string) => {
      if (removedTaskId === viewedAgentTaskId) {
        // No retainReason cleanup needed: TaskRegistry.remove() deletes the
        // task before emitting task_removed.
        setViewedAgentTaskId(undefined);
      }
      if (removedTaskId === viewedWorkflowTaskId) {
        setViewedWorkflowTaskId(undefined);
      }
    };

    taskRegistry.on('task_removed', handleTaskRemoved);
    return () => {
      taskRegistry.off('task_removed', handleTaskRemoved);
    };
  }, [taskRegistry, viewedAgentTaskId, viewedWorkflowTaskId]);
  // Periodic eviction of terminal tasks past their grace period
  useEffect(() => {
    const interval = setInterval(() => taskRegistry.evictAllTerminal(), 1_000);
    return () => clearInterval(interval);
  }, [taskRegistry]);

  const viewWorkflowSessions = useCallback(() => {
    if (viewedAgentTaskId) {
      releaseTaskView(viewedAgentTaskId);
      setViewedAgentTaskId(undefined);
    }
    if (viewedWorkflowTaskId) {
      releaseTaskView(viewedWorkflowTaskId);
      setViewedWorkflowTaskId(undefined);
    }
    setSessionRailSelectionMode('workflows');
  }, [releaseTaskView, viewedAgentTaskId, viewedWorkflowTaskId]);

  const viewMainSession = useCallback(() => {
    if (viewedAgentTaskId) {
      releaseTaskView(viewedAgentTaskId);
    }
    if (viewedWorkflowTaskId) {
      releaseTaskView(viewedWorkflowTaskId);
    }
    setViewedAgentTaskId(undefined);
    setSessionRailSelectionMode(undefined);
    setViewedWorkflowTaskId(undefined);
  }, [releaseTaskView, viewedAgentTaskId, viewedWorkflowTaskId]);

  const [customDialog, setCustomDialog] = useState<React.ReactNode | null>(
    null,
  );
  // Ref tracks whether a customDialog is currently open, so the guarded
  // setter below never has a stale closure over `customDialog`.
  const customDialogRef = useRef<React.ReactNode | null>(null);
  customDialogRef.current = customDialog;

  /**
   * Guarded setter: rejects opening a new dialog when one is already
   * displayed. Closing (passing null) is always allowed.
   */
  const setCustomDialogGuarded = useCallback(
    (dialog: React.ReactNode | null): boolean => {
      if (dialog !== null && customDialogRef.current !== null) {
        return false; // reject — a dialog is already open
      }
      setCustomDialog(dialog);
      return true;
    },
    [],
  );
  const [fullScreenDialog, setFullScreenDialog] =
    useState<React.ReactNode | null>(null);
  const [pendingRestorePrompt, setPendingRestorePrompt] = useState(false);

  const [adminSettingsChanged, setAdminSettingsChanged] = useState(false);

  // Fold state — managed by FoldStateContext (Phase 7)
  const {
    cycleFoldLevel,
    constrainHeight,
    isExpanded,
    toggleExpansion,
    toggleAllExpansion,
    resetToConstrained,
  } = useFoldState();

  // Backward-compat shim: maps old setConstrainHeight(bool) to FoldState API.
  // Used by UIActions interface consumers. Will be removed once all consumers
  // migrate to useFoldState() directly.
  const setConstrainHeight = useCallback(
    (value: boolean) => {
      if (value && !constrainHeight) {
        resetToConstrained();
      } else if (!value && constrainHeight) {
        cycleFoldLevel();
      }
    },
    [constrainHeight, resetToConstrained, cycleFoldLevel],
  );

  const [shellModeActive, setShellModeActive] = useState(false);
  const [conversationKey, setConversationKey] = useState(0);
  const [conversationScreen, setConversationScreen] =
    useState<ConversationScreen>('prompt');
  const [settingsNonce, setSettingsNonce] = useState(0);
  const activeHooks = useHookDisplayState();
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const visibleBackgroundRunningCount = useMemo(
    () =>
      getBackgroundTaskStatusCount({
        tasks: visibleUnifiedTasks,
      }),
    [visibleUnifiedTasks],
  );
  const showBackgroundTaskList = useCallback(
    ({ toggle = false }: { toggle?: boolean } = {}): boolean => {
      if (visibleUnifiedTasks.length === 0) {
        return false;
      }
      if (toggle && customDialogRef.current) {
        setCustomDialog(null);
      } else {
        setCustomDialog(
          <LiveUnifiedTaskPanel
            onClose={() => setCustomDialog(null)}
            addInfoItem={(text) =>
              historyManager.addItem({ type: 'info', text }, Date.now())
            }
          />,
        );
      }
      focusMachine?.focusChat();
      return true;
    },
    [focusMachine, historyManager, visibleUnifiedTasks.length],
  );
  const openBackgroundTaskList = useCallback(
    () => showBackgroundTaskList(),
    [showBackgroundTaskList],
  );
  const [isTrustedFolder, setIsTrustedFolder] = useState<boolean | undefined>(
    () =>
      isWorkspaceTrusted(settings.merged, config.storage.getProjectRoot())
        .isTrusted,
  );

  const [queueErrorMessage, setQueueErrorMessage] = useTimedMessage<string>(
    QUEUE_ERROR_DISPLAY_DURATION_MS,
  );

  // Permission Pipeline: access queue store for Ctrl+C abort handling
  const permissionQueueStore = useOptionalPermissionQueueStore();
  const permissionQueueItems = useOptionalPermissionQueue(permissionQueueStore);
  const permissionQueueHasItems = permissionQueueItems.length > 0;

  // Lookup function for ToolActionsProvider — resolves PermissionRequestItem by id
  const permissionQueueLookup = useCallback(
    (id: string) => permissionQueueStore?.getById(id),
    [permissionQueueStore],
  );

  const [expandHintTrigger, triggerExpandHint] = useTimedMessage<boolean>(
    EXPAND_HINT_DURATION_MS,
  );
  const showIsExpandableHint = Boolean(expandHintTrigger);
  const overflowState = useOverflowState();
  const overflowingIdsSize = overflowState?.overflowingIds.size ?? 0;
  const hasOverflowState = overflowingIdsSize > 0 || !constrainHeight;

  /**
   * Manages the visibility and x-second timer for the expansion hint.
   *
   * By depending on overflowingIdsSize, the timer resets when new views
   * overflow, but avoids infinitely resetting during single-view streaming.
   */
  useEffect(() => {
    if (hasOverflowState) {
      triggerExpandHint(true);
    }
  }, [hasOverflowState, overflowingIdsSize, triggerExpandHint]);

  const { addConfirmUpdateExtensionRequest, confirmUpdateExtensionRequests } =
    useConfirmUpdateRequests();
  const {
    extensionsUpdateState,
    extensionsUpdateStateInternal,
    dispatchExtensionStateUpdate,
  } = useExtensionUpdates(
    historyManager.addItem,
    config.getEnableExtensionReloading(),
  );

  const [isWorktreeExitDialogOpen, setIsWorktreeExitDialogOpen] =
    useState(false);
  const openWorktreeExitDialog = useCallback(() => {
    const worktreeSettings = config.getWorktreeSettings();
    if (!worktreeSettings || !ownsWorktreeLifecycle(worktreeSettings)) {
      return;
    }
    setIsWorktreeExitDialogOpen(true);
  }, [config]);
  const closeWorktreeExitDialog = useCallback(
    (_choice: 'keep' | 'remove', _message: string) => {
      setIsWorktreeExitDialogOpen(false);
      // Exit in the next tick to avoid blocking the React render cycle.
      // The WorktreeExitDialog already performed all cleanup before
      // calling onDone, so we just need to run exit hooks and exit.
      setTimeout(async () => {
        setQuittingMessages([]);
        sessionLogger.setExitContext({
          reason: 'success',
          exit_code: 0,
          message: 'Worktree exit dialog closed, cleanup complete',
          source: 'ui.appContainer',
        });
        await gracefulExit(0, { exitReason: 'user_quit' });
      }, 0);
    },
    [],
  );

  const {
    isAgentConfigDialogOpen,
    isAgentBrowserOpen,
    agentBrowserActiveTab,
    selectedAgentName,
    selectedAgentDefinition,
    setAgentBrowserActiveTab,
    openAgentConfigDialog,
    closeAgentConfigDialog,
    openAgentBrowser,
    closeAgentBrowser,
  } = useAgentDialogs();

  const {
    isSkillBrowserOpen,
    isSkillDetailViewOpen,
    selectedSkillInfo,
    openSkillBrowser,
    closeSkillBrowser,
    openSkillDetailView,
    closeSkillDetailView,
    isPluginBrowserOpen,
    pluginBrowserArgs,
    openPluginBrowser,
    closePluginBrowser,
    isConfigErrorDetailOpen,
    selectedConfigError,
    configErrorLabel,
    openConfigErrorDetail,
    closeConfigErrorDetail,
    isHookBrowserOpen,
    isHookConfigDialogOpen,
    selectedHookEntry,
    openHookBrowser,
    closeHookBrowser,
    openHookConfigDialog,
    closeHookConfigDialog,
    isMcpBrowserOpen,
    openMcpBrowser,
    closeMcpBrowser,
  } = useBrowserDialogs();

  const [pendingRunAgent, setPendingRunAgent] = useState<{
    name: string;
    query: string;
  } | null>(null);

  const toggleDebugProfiler = useCallback(
    () => setShowDebugProfiler((prev) => !prev),
    [],
  );

  const {
    currentModel,
    setCurrentModel,
    currentReasoningEffort,
    setCurrentReasoningEffort,
    currentContextWindow,
    setCurrentContextWindow,
  } = useModelViewState(uiConfig);

  const [isConfigInitialized, setConfigInitialized] = useState(false);
  const [startupInitializationError, setStartupInitializationError] =
    useState<Error | null>(null);

  const logger = useLogger(config.storage);
  const { inputHistory, addInput, initializeFromLogger } =
    useInputHistoryStore();

  // Terminal and layout hooks
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const app: AppProps = useApp();

  // Additional hooks moved from App.tsx
  const { stats: sessionStats } = useSessionStats();
  const branchName = useGitBranchName(config.getTargetDir());

  // Layout measurements
  // For performance profiling only
  const rootUiRef = useRef<DOMElement>(null);
  const staticExtraHeight = 3;

  /** Refreshed each render — Stop hook reads latest transcript + prompt overrides. */
  const autoMemoryMessagesRef = useRef<() => Message[]>(() => []);
  const disposeProjectServicesRef = useRef<() => Promise<void>>(async () => {});
  const disposeLocalSessionRef = useRef<() => Promise<void>>(async () => {});
  const [transientMessage, showTransientMessage] = useTransientMessage(
    WARNING_PROMPT_DURATION_MS,
  );

  const sessionStartupRuntime = useMemo(
    () => createSessionStartupRuntime(),
    [],
  );
  const [isSelectingInitialSession, setIsSelectingInitialSession] = useState(
    Boolean(
      props.initialSessionBrowserOptions &&
        !resumedSessionData &&
        !hasSessionBinding,
    ),
  );
  const deferredInitialSessionStartRef = useRef(
    Boolean(props.onInitialResumeComplete || isSelectingInitialSession),
  );
  const initialSessionStartSettledRef = useRef(false);

  const sessionStartLifetime = useMemo(
    () => ({
      controller: new AbortController(),
      pending: new Set<Promise<void>>(),
    }),
    // These identities delimit the project initialization, including a resume
    // that reuses Config. Reusing an aborted controller would skip its hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, resumedSessionData, hasSessionBinding],
  );

  const fireSessionStartHook = useCallback(
    async (source: SessionStartSource): Promise<void> => {
      const signal = sessionStartLifetime.controller.signal;
      if (signal.aborted) return;
      const pending = (async () => {
        const result = await config
          .getHookSystem()
          ?.fireSessionStartEvent(source, config.getModel(), signal);

        if (result && !signal.aborted) {
          if (result.systemMessage) {
            historyManager.addItem(
              {
                type: MessageType.INFO,
                text: result.systemMessage,
              },
              Date.now(),
            );
          }

          const additionalContext = result.getAdditionalContext();
          if (additionalContext) {
            queueHookContextRef.current?.(
              additionalContext,
              HookEventName.SessionStart,
              'additionalContext',
            );
          }

          const stdoutForModel = result.getStdoutForModel(
            HookEventName.SessionStart,
          );
          if (stdoutForModel && !result.suppressOutput) {
            queueHookContextRef.current?.(
              stdoutForModel,
              HookEventName.SessionStart,
              'stdout',
            );
          }
        }
      })();
      sessionStartLifetime.pending.add(pending);
      try {
        await pending;
      } finally {
        sessionStartLifetime.pending.delete(pending);
      }
    },
    [config, historyManager, sessionStartLifetime],
  );

  const completeInitialSessionStart = useCallback(
    async (source: SessionStartSource): Promise<void> => {
      if (initialSessionStartSettledRef.current) {
        return;
      }
      initialSessionStartSettledRef.current = true;
      deferredInitialSessionStartRef.current = false;

      try {
        sessionStartupRuntime.markStarted('session-start');
        await fireSessionStartHook(source);
        if (sessionStartLifetime.controller.signal.aborted) return;
        sessionStartupRuntime.markReady('session-start');
      } catch (err) {
        runLogger.warn('SessionStart hook execution failed:', err);
        sessionStartupRuntime.markDegraded('session-start', {
          code: 'session-hooks-failed',
          message:
            err instanceof Error
              ? err.message
              : 'SessionStart hook execution failed',
          error: err,
        });
      } finally {
        if (!sessionStartLifetime.controller.signal.aborted) {
          setIsSelectingInitialSession(false);
        }
      }
    },
    [fireSessionStartHook, sessionStartupRuntime, sessionStartLifetime],
  );

  const failDeferredInitialSessionStart = useCallback(
    (error?: unknown): void => {
      if (
        !deferredInitialSessionStartRef.current ||
        initialSessionStartSettledRef.current
      ) {
        return;
      }
      initialSessionStartSettledRef.current = true;
      deferredInitialSessionStartRef.current = false;
      setIsSelectingInitialSession(false);
      sessionStartupRuntime.markDegraded('session-start', {
        code: 'session-start-initialization-failed',
        message: 'Initial session resume failed',
        error,
      });
    },
    [sessionStartupRuntime],
  );

  /**
   * First-turn readiness for the local TUI session. The UI can render and accept
   * input after base config init, but the first submitted prompt waits for
   * initial commands, project memory, and SessionStart hook context.
   */
  const awaitSessionStartHooks = useCallback(
    async (signal?: AbortSignal) => {
      await waitForTuiFirstTurnReady(config, sessionStartupRuntime, { signal });
    },
    [config, sessionStartupRuntime],
  );

  useEffect(() => {
    let cancelled = false;
    void waitForTuiFirstTurnReady(config, sessionStartupRuntime)
      .then(() => {
        if (cancelled) return;
        const startMode = process.argv.includes('--continue')
          ? 'continue'
          : resumedSessionData
            ? 'resume'
            : 'interactive_repl';
        markStartupMilestone('tui_first_turn_ready', undefined, {
          start_mode: startMode,
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          runLogger.debug(
            '[startup] Failed to observe TUI first-turn readiness:',
            err instanceof Error ? err.message : err,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config, resumedSessionData, sessionStartupRuntime]);

  useEffect(() => {
    let cancelled = false;
    let drainAutoMemory: (() => Promise<void>) | undefined;
    let stopAutoMemoryListener: (() => void) | undefined;
    let hydration: Promise<unknown> | undefined;
    const initialization = (async () => {
      let sessionStartAttempted = false;
      let sessionStartDeferred = false;
      let configInitializationComplete = false;
      let startupError: Error | undefined;
      try {
        // The program cannot run if config initialization fails. Capture that
        // error below and rethrow from render so Ink's root boundary exits.
        if (!config.isInitialized()) {
          const startupConfig = config as InteractiveStartupConfig;
          if (startupConfig.initializeForInteractiveStartup) {
            await startupConfig.initializeForInteractiveStartup();
          } else {
            await config.initialize();
          }
        }
        if (cancelled) return;
        if (!hasSessionBinding) await applyStartupModel(config);
        if (cancelled) return;
        setConfigInitialized(true);
        markStartupMilestone('tui_input_ready');
        configInitializationComplete = true;
        const startupConfig = config as InteractiveStartupConfig;
        const hydrationPromise = startupConfig.hydrateAfterFirstRender?.();
        hydration = hydrationPromise;
        if (hydrationPromise) {
          const hydrationStartedAt = Date.now();
          runLogger.debug('[startup] Background config hydration started');
          void hydrationPromise
            .then(() => {
              runLogger.debug(
                `[startup] Background config hydration completed duration_ms=${Date.now() - hydrationStartedAt}`,
              );
            })
            .catch((err: unknown) => {
              runLogger.warn(
                `[startup] Background config hydration failed duration_ms=${Date.now() - hydrationStartedAt}:`,
                err instanceof Error ? err.message : err,
              );
            });
        } else {
          runLogger.debug('[startup] Background config hydration skipped');
        }

        // Auto-memory: listen for turn-complete events for background extraction.
        // The service is always created so that toggling auto-memory mid-session
        // takes effect without a restart.
        {
          const autoMemDir = getAutoMemoryDir(config.storage);
          const autoMemService = new AutoMemoryExtractionService(config, {
            onMemoriesSaved: (memoryPaths: string[]) => {
              const count = memoryPaths.length;
              if (count === 0) return;

              appEvents.emit(AppEvent.TransientMessage, {
                id: 'auto-memory-saved',
                message: `Memory saved ${count} ${
                  count === 1 ? 'item' : 'items'
                }`,
                type: TransientMessageType.Success,
                durationMs: AUTO_MEMORY_SAVED_STATUS_DURATION_MS,
              });
            },
            onMemoryRefresh: () => {
              coreEvents.emit(CoreEvent.MemoryChanged, {
                sessionId: config.getSessionId(),
                fileCount: config.getMemoryMdFileCount(),
              });
            },
          });

          // Trigger extraction after each turn completes
          const onTurnComplete = ({
            prompt,
            promptResponse,
            requestId,
            parentRequestSetId,
            parentBusinessInfo,
          }: TurnCompletePayload) => {
            // Check dynamically so toggling auto-memory mid-session takes effect.
            if (!config.isAutoMemoryEnabled()) return;

            ensureAutoMemoryDir(autoMemDir).catch((e: unknown) => {
              runLogger.error('Failed to create auto-memory dir:', e);
            });

            const messages = autoMemoryMessagesRef.current();
            const renderedByParent = config.getSystemPrompt?.();
            if (renderedByParent === undefined) {
              runLogger.debug(
                '[AutoMemory] skipped extraction: parent prompt unavailable',
              );
              return;
            }
            void autoMemService
              .onTurnComplete({
                prompt,
                response: promptResponse,
                messages,
                systemPrompt: renderedByParent,
                parentRequestId: requestId,
                parentRequestSetId,
                parentBusinessInfo,
              })
              .catch((err: unknown) =>
                runLogger.debug('[AutoMemory] extraction error:', err),
              );
          };
          coreEvents.on(CoreEvent.TurnComplete, onTurnComplete);
          stopAutoMemoryListener = () =>
            coreEvents.off(CoreEvent.TurnComplete, onTurnComplete);

          // Drain pending extractions and remove listener on exit
          drainAutoMemory = async () => {
            // 重建项目时不能把超时视为已退出，否则旧任务会读到新项目的进程环境。
            // 进程退出仍由外层退出清理预算限制总等待时间。
            await autoMemService.drain();
          };
        }

        if (deferredInitialSessionStartRef.current) {
          // The initial --resume action owns SessionStart. Other startup work
          // continues while the session browser is open.
          sessionStartDeferred = true;
        } else {
          sessionStartAttempted = true;
          await completeInitialSessionStart(
            resumedSessionData || hasSessionBinding
              ? SessionStartSource.Resume
              : SessionStartSource.Startup,
          );
        }
      } catch (err: unknown) {
        startupError = toStartupInitializationError(err);
        const message = startupError.message;
        runLogger.warn('[startup] Config initialization failed:', startupError);
        historyManager.addItem(
          {
            type: MessageType.ERROR,
            text: message,
          },
          Date.now(),
        );
      } finally {
        const sessionStartState =
          sessionStartupRuntime.snapshot()['session-start'];
        if (
          sessionStartState.status === 'pending' &&
          (!sessionStartDeferred || startupError)
        ) {
          if (sessionStartAttempted) {
            sessionStartupRuntime.markReady('session-start');
          } else {
            const message =
              startupError instanceof Error
                ? startupError.message
                : 'Config initialization failed before SessionStart hooks';
            sessionStartupRuntime.markFailed('session-start', {
              code: configInitializationComplete
                ? 'session-start-initialization-failed'
                : 'config-initialization-failed',
              message,
              error: startupError,
            });
          }
        }
        if (startupError && !cancelled) {
          setStartupInitializationError(startupError);
        }
      }
    })().catch((err: unknown) => {
      if (!cancelled)
        setStartupInitializationError(toStartupInitializationError(err));
    });
    let cleanupPromise: Promise<void> | undefined;
    const cancelInitialization = async () => {
      cancelled = true;
      sessionStartLifetime.controller.abort();
      stopAutoMemoryListener?.();
      await initialization;
      await Promise.allSettled([...sessionStartLifetime.pending]);
    };
    const unregisterCancellation =
      registerExitCancellation(cancelInitialization);
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        await cancelInitialization();
        await hydration?.catch(() => undefined);
        await drainAutoMemory?.();
      })();
      return cleanupPromise;
    };
    disposeProjectServicesRef.current = cleanup;
    const unregister = registerCleanup(cleanup);
    return () => {
      unregisterCancellation();
      unregister();
      void cleanup().catch((error) =>
        runLogger.warn('[session.resume] project_cleanup_failed', error),
      );
    };
    // Disable the dependencies check here. historyManager gets flagged
    // but we don't want to react to changes to it because each new history
    // item, including the ones from the start session hook will cause a
    // re-render and an error when we try to reload config.
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    config,
    resumedSessionData,
    hasSessionBinding,
    sessionStartLifetime,
    applyStartupModel,
  ]);

  useEffect(
    () => () => {
      sessionStartupRuntime.dispose();
    },
    [sessionStartupRuntime],
  );

  useEffect(
    () => setUpdateHandler(historyManager.addItem, setUpdateInfo),
    [historyManager.addItem],
  );

  useEffect(() => {
    const handleSettingsChanged = () => {
      setSettingsNonce((prev) => prev + 1);
      // Sync disableAllHooks runtime flag so hooks can hot-recover
      // when the user flips disableAllHooks back to false.
      const allDisabled =
        settings.merged.disableAllHooks === true ||
        !settings.merged.hooksConfig.enabled;
      baseConfig.setAllHooksDisabled(allDisabled);
    };

    const handleAdminSettingsChanged = () => {
      setAdminSettingsChanged(true);
    };

    coreEvents.on(CoreEvent.SettingsChanged, handleSettingsChanged);
    coreEvents.on(CoreEvent.AdminSettingsChanged, handleAdminSettingsChanged);
    return () => {
      coreEvents.off(CoreEvent.SettingsChanged, handleSettingsChanged);
      coreEvents.off(
        CoreEvent.AdminSettingsChanged,
        handleAdminSettingsChanged,
      );
    };
  }, [settings, baseConfig]);

  const { errorCount, clearErrorCount } = useErrorCount();

  const mainAreaWidth = calculateMainAreaWidth(terminalWidth, config);
  // Derive widths for InputPrompt using shared helper
  const { inputWidth, suggestionsWidth } = useMemo(() => {
    const { inputWidth, suggestionsWidth } =
      calculatePromptWidths(mainAreaWidth);
    return { inputWidth, suggestionsWidth };
  }, [mainAreaWidth]);

  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);

  const getPreferredEditor = useCallback(
    () => settings.merged.general.preferredEditor as EditorType,
    [settings.merged.general.preferredEditor],
  );

  const bufferRef = useRef<TextBuffer | null>(null);

  const stableSetText = useCallback((text: string) => {
    bufferRef.current?.setText(text);
  }, []);

  // Initialize input history from logger (past sessions)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    initializeFromLogger(logger);
  }, [logger, initializeFromLogger]);

  // One-time prompt to suggest running /terminal-setup when it would help.
  const { terminalSetupTip } = useTerminalSetupPrompt({
    addConfirmUpdateExtensionRequest,
    addItem: historyManager.addItem,
    screenReader: config.getScreenReader(),
  });
  const terminalSetupAdditionalTips = useMemo(
    () => (terminalSetupTip ? [terminalSetupTip] : []),
    [terminalSetupTip],
  );

  const requestRender = useCallback(() => {
    app.rerender();
  }, [app]);

  const requestViewportReset = useCallback(() => {
    if (app.requestViewportReset) {
      app.requestViewportReset();
    } else {
      app.rerender();
    }
  }, [app]);

  const clearConversation = useCallback(() => {
    app.clearConversation?.();
    setConversationKey((prev) => prev + 1);
  }, [app]);

  const replaceConversation = useCallback(() => {
    setConversationKey((prev) => prev + 1);
    requestViewportReset();
  }, [requestViewportReset]);

  const replaceTranscriptConversation = useCallback(() => {
    setConversationKey((prev) => prev + 1);
    if (app.requestTranscriptReplacement) {
      app.requestTranscriptReplacement();
    } else {
      requestViewportReset();
    }
  }, [app, requestViewportReset]);

  const commitItem = historyManager.addItem;

  const shouldUseAlternateScreen = shouldEnterAlternateScreen(
    isAlternateBuffer,
    config.getScreenReader(),
  );

  const handleEditorOpening = useCallback((payload?: ExternalEditorPayload) => {
    // Default to the terminal path: a missing payload means an emitter we
    // don't know about, and under-restoring the terminal is far worse than
    // an unnecessary repaint.
    const isTerminal = payload?.isTerminal ?? true;
    // A GUI editor opens in its own window, so the terminal never changes
    // hands — we hand over nothing. Leaving raw mode on is what matters:
    // suspending stdin drops the tty back to canonical mode, where ECHO
    // paints every keystroke onto the live frame, ICANON queues the bytes
    // for delivery once the editor closes, and ISIG turns Ctrl+C into a
    // SIGINT that kills the CLI. Input is dropped in software instead —
    // see inputLockedRef in KeypressContext.
    if (!isTerminal) {
      return;
    }
    const ink = inkInstances.get(process.stdout);
    if (!ink) {
      return;
    }
    // Use Ink's enterAlternateScreen() which properly:
    // 1. Pauses rendering
    // 2. Suspends stdin (removes readable listeners, disables raw mode)
    // 3. Disables Kitty keyboard protocol, modifyOtherKeys, mouse, focus reporting
    // 4. Shows cursor and clears screen for the editor
    ink.enterAlternateScreen();
  }, []);

  const handleEditorClose = useCallback(
    (payload?: ExternalEditorPayload) => {
      const isTerminal = payload?.isTerminal ?? true;
      // Mirror of the GUI branch above: nothing was handed over, so there is
      // nothing to restore. KeypressContext releases its own lock.
      if (!isTerminal) {
        return;
      }
      const ink = inkInstances.get(process.stdout);
      // Use Ink's exitAlternateScreen() which properly:
      // 1. Resumes stdin (re-attaches readable listeners, re-enables raw mode)
      // 2. Resumes rendering
      // 3. Re-enables Kitty keyboard, modifyOtherKeys, focus reporting
      // 4. Resets frame buffers for a clean repaint
      if (ink) {
        ink.exitAlternateScreen();
      } else {
        requestViewportReset();
      }
      if (shouldUseAlternateScreen) {
        enableMouseEvents();
        disableLineWrapping();
      }
      terminalCapabilityManager.enableSupportedModes();
    },
    [requestViewportReset, shouldUseAlternateScreen],
  );

  const [editorError, setEditorError] = useState<string | null>(null);
  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, historyManager.addItem);

  useEffect(() => {
    coreEvents.on(CoreEvent.ExternalEditorOpening, handleEditorOpening);
    coreEvents.on(CoreEvent.ExternalEditorClosed, handleEditorClose);
    coreEvents.on(CoreEvent.RequestEditorSelection, openEditorDialog);
    return () => {
      coreEvents.off(CoreEvent.ExternalEditorOpening, handleEditorOpening);
      coreEvents.off(CoreEvent.ExternalEditorClosed, handleEditorClose);
      coreEvents.off(CoreEvent.RequestEditorSelection, openEditorDialog);
    };
  }, [handleEditorOpening, handleEditorClose, openEditorDialog]);

  const { isSettingsDialogOpen, openSettingsDialog, closeSettingsDialog } =
    useSettingsCommand();

  const {
    isThemeDialogOpen,
    openThemeDialog,
    closeThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(
    settings,
    setThemeError,
    historyManager.addItem,
    initialThemeError,
    requestRender,
  );
  // Follow the terminal background color while ui.theme is 'auto'
  useTerminalTheme(config, requestRender);
  // A product-provided session gate reports where it stands; without one the
  // session is usable right away.
  const SessionGate = props.SessionGate;
  const hasSessionGate = SessionGate !== undefined;
  const [sessionGateState, setSessionGateState] = useState<SessionGateState>(
    () => (hasSessionGate ? INITIAL_SESSION_GATE : OPEN_SESSION_GATE),
  );
  const isSessionGateChecking =
    sessionGateState.status === 'checking' && sessionGateState.visible;
  useEffect(() => {
    if (!isConfigInitialized || sessionGateState.status === 'checking') {
      return;
    }
    void runAfterConfigInitializedStartup(config).catch((err: unknown) => {
      runLogger.debug(
        '[startup] Failed to run post-config startup work:',
        err instanceof Error ? err.message : err,
      );
    });
  }, [config, isConfigInitialized, sessionGateState.status]);

  // Session browser and resume functionality
  const isRuntimeReady = isConfigInitialized;
  const replaceRunLoopMessagesRef = useRef<ReplaceMessagesFn>(async () => {});
  const queueHookContextRef = useRef<
    | ((
        context: string,
        hookEventName?: HookEventName,
        sourceType?: PendingHookOutput['sourceType'],
      ) => void)
    | null
  >(null);

  const refreshContextTokenCountRef = useRef<() => Promise<void>>(
    async () => {},
  );
  const resumedCustomTitleTapRef = useRef<
    ((title: string | undefined, sessionId: string) => void) | null
  >(null);
  const {
    loadHistoryForResume,
    isResuming,
    isAutomaticInputBlocked,
    resumeAutomaticInput,
  } = useSessionResume({
    config,
    historyManager,
    requestTranscriptReplacement: replaceTranscriptConversation,
    isRuntimeReady,
    setQuittingMessages,
    resumedSessionData,
    worktreeStartupRequest: props.worktreeStartupRequest,
    isStartupHeld: isSessionGateChecking,
    refreshContextTokenCount: () => refreshContextTokenCountRef.current(),
    replaceMessages: (messages, sessionId, options) =>
      replaceRunLoopMessagesRef.current(messages, sessionId, options),
    onResumedCustomTitle: (title, sessionId) =>
      resumedCustomTitleTapRef.current?.(title, sessionId),
    onProjectResume: props.onProjectResume
      ? async (data, options) => {
          try {
            await disposeProjectServicesRef.current();
            await disposeLocalSessionRef.current();
          } catch (error) {
            // 旧运行环境已经开始关闭，不能在失败后重新开放输入。
            setStartupInitializationError(toStartupInitializationError(error));
            throw error;
          }
          return props.onProjectResume
            ? props.onProjectResume(data, options)
            : false;
        }
      : undefined,
    initialResumeOptions: props.initialResumeOptions,
    onInitialResumeComplete: props.onInitialResumeComplete
      ? async (success) => {
          if (success) {
            await completeInitialSessionStart(SessionStartSource.Resume);
          } else {
            await Promise.allSettled([
              disposeProjectServicesRef.current(),
              disposeLocalSessionRef.current(),
            ]);
          }
          props.onInitialResumeComplete?.(success);
        }
      : undefined,
  });
  const notifyInitialResumeComplete = props.onInitialResumeComplete;
  useEffect(() => {
    if (
      startupInitializationError &&
      notifyInitialResumeComplete &&
      !initialSessionStartSettledRef.current
    ) {
      void (async () => {
        await Promise.allSettled([
          disposeProjectServicesRef.current(),
          disposeLocalSessionRef.current(),
        ]);
        notifyInitialResumeComplete(false);
      })();
    }
  }, [startupInitializationError, notifyInitialResumeComplete]);
  const loadHistoryFromSessionBrowser = useCallback(
    async (
      ...args: Parameters<typeof loadHistoryForResume>
    ): Promise<boolean> => {
      const isInitialDeferredResume = deferredInitialSessionStartRef.current;
      const didResume = await loadHistoryForResume(args[0], args[1], {
        ...args[2],
        endOutgoingSession: !isInitialDeferredResume,
      });
      if (props.onProjectResume && needsProjectRebuild(config, args[1])) {
        return didResume;
      }
      if (isInitialDeferredResume) {
        if (didResume) {
          await completeInitialSessionStart(SessionStartSource.Resume);
        } else {
          failDeferredInitialSessionStart();
        }
      } else if (didResume) {
        // Mid-session resume (e.g. the /resume slash command) must re-fire
        // SessionStart with the resume source; the initial startup already
        // settled under its own source.
        try {
          await fireSessionStartHook(SessionStartSource.Resume);
        } catch (err) {
          runLogger.warn('SessionStart hook execution failed:', err);
        }
      }
      return didResume;
    },
    [
      completeInitialSessionStart,
      failDeferredInitialSessionStart,
      fireSessionStartHook,
      loadHistoryForResume,
      config,
      props.onProjectResume,
    ],
  );
  const fallBackToSessionStartup = useCallback(() => {
    if (deferredInitialSessionStartRef.current) {
      void completeInitialSessionStart(SessionStartSource.Startup);
    }
  }, [completeInitialSessionStart]);
  const {
    isSessionBrowserOpen,
    sessionBrowserOptions,
    openSessionBrowser,
    closeSessionBrowser: closeSessionBrowserRaw,
    handleResumeSession,
    handleDeleteSession: handleDeleteSessionSync,
  } = useSessionBrowser(
    config,
    loadHistoryFromSessionBrowser,
    failDeferredInitialSessionStart,
  );
  const closeSessionBrowser = useCallback(() => {
    closeSessionBrowserRaw();
    fallBackToSessionStartup();
  }, [closeSessionBrowserRaw, fallBackToSessionStartup]);
  // Wrap handleDeleteSession to return a Promise for UIActions interface
  const handleDeleteSession = useCallback(
    async (session: SessionInfo): Promise<void> => {
      await handleDeleteSessionSync(session);
    },
    [handleDeleteSessionSync],
  );
  const resumeSessionFromCommands = useCallback(
    async (resumedData: SessionResumeData) => {
      const historyData = convertMessagesToHistoryFormats(resumedData.messages);
      return loadHistoryFromSessionBrowser(historyData.uiHistory, resumedData, {
        endOutgoingSession: true,
      });
    },
    [loadHistoryFromSessionBrowser],
  );
  const hasAppliedInitialSessionBrowserOptions = useRef(false);
  useEffect(() => {
    if (hasAppliedInitialSessionBrowserOptions.current) {
      return;
    }
    if (!props.initialSessionBrowserOptions) {
      return;
    }
    if (!isRuntimeReady) {
      return;
    }

    hasAppliedInitialSessionBrowserOptions.current = true;
    openSessionBrowser(props.initialSessionBrowserOptions);
  }, [props.initialSessionBrowserOptions, isRuntimeReady, openSessionBrowser]);

  const { toggleVimEnabled } = useVimMode();

  const openRewindDialogRef = useRef<() => void>(() => {});
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);

  const {
    cleanUiDetailsVisible,
    setCleanUiDetailsVisible,
    toggleCleanUiDetailsVisible,
    revealCleanUiDetailsTemporarily,
  } = useVisibilityToggle();

  // MCP server approval state — declared early so `slashCommandActions`
  // (and therefore `/mcp reload`) can open the approval dialog directly.
  const [isMcpApprovalDialogOpen, setIsMcpApprovalDialogOpen] = useState(false);
  const [pendingProjectMcpServers, setPendingProjectMcpServers] = useState<
    Record<string, import('@qwen-code/core').MCPServerConfig>
  >({});

  const slashCommandActions = useMemo(
    () => ({
      openThemeDialog,
      openEditorDialog,
      openSettingsDialog,
      openSessionBrowser,
      openRewindDialog: () => openRewindDialogRef.current(),
      openAgentConfigDialog,
      openAgentBrowser,
      openSkillBrowser,
      openPluginBrowser: (args?: string) => openPluginBrowser(args),
      openMcpBrowser,
      openMcpApprovalDialog: (
        pending: Record<string, import('@qwen-code/core').MCPServerConfig>,
      ) => {
        if (!pending || Object.keys(pending).length === 0) return;
        setPendingProjectMcpServers(pending);
        setIsMcpApprovalDialogOpen(true);
      },
      openHookBrowser,
      openWorktreeExitDialog,
      quit: (messages: HistoryItem[]) => {
        // If in a worktree session, show exit dialog first.
        // Don't set quittingMessages yet — that switches to QuittingDisplay
        // and hides the dialog. Set it only after the dialog completes.
        const worktreeSettings = config.getWorktreeSettings();
        if (worktreeSettings && ownsWorktreeLifecycle(worktreeSettings)) {
          setIsWorktreeExitDialogOpen(true);
          return;
        }
        setQuittingMessages(messages);
        setTimeout(async () => {
          sessionLogger.setExitContext({
            reason: 'success',
            exit_code: 0,
            message: 'User quit the application',
            source: 'ui.appContainer',
          });
          await gracefulExit(0, { exitReason: 'user_quit' });
        }, 100);
      },
      setDebugMessage,
      toggleCorgiMode: () =>
        setCorgiMode((prev) => {
          const enabled = !prev;
          return enabled;
        }),
      toggleDebugProfiler,
      dispatchExtensionStateUpdate,
      addConfirmUpdateExtensionRequest,
      toggleShortcutsHelp: () => setShortcutsHelpVisible((visible) => !visible),
      setText: stableSetText,
      viewWorkflowSessions,
      viewMainSession,
    }),
    [
      openThemeDialog,
      openEditorDialog,
      openSettingsDialog,
      openSessionBrowser,
      openAgentConfigDialog,
      openAgentBrowser,
      openSkillBrowser,
      openPluginBrowser,
      openMcpBrowser,
      openHookBrowser,
      setQuittingMessages,
      setDebugMessage,
      setCorgiMode,
      dispatchExtensionStateUpdate,
      openWorktreeExitDialog,
      addConfirmUpdateExtensionRequest,
      toggleDebugProfiler,
      setShortcutsHelpVisible,
      stableSetText,
      viewWorkflowSessions,
      viewMainSession,
      config,
    ],
  );

  const paidConfirmationRef = useRef<{
    payload: ConsentRequestPayload;
    finish: (confirmed: boolean) => void;
  } | null>(null);
  const [isPaidConfirmationPending, setPaidConfirmationPending] = useReducer(
    (_previous: boolean, next: boolean) => next,
    false,
  );
  const paidConfirmationModel = uiConfig.getModel();
  useEffect(() => {
    const paid = paidConfirmationRef.current;
    if (paid && paid.payload.modelPaid?.model !== paidConfirmationModel)
      paid.finish(false);
  }, [paidConfirmationModel]);
  const [authConsentRequest, setAuthConsentRequest] =
    useState<ConfirmationRequest | null>(null);

  useEffect(() => {
    let cleanupConsent = () => {};
    const handleConsentRequest = (payload: ConsentRequestPayload) => {
      if (payload.modelPaid) {
        const sessionId =
          sessionView.sessionState.sessionId ?? config.getSessionId();
        if (
          payload.modelPaid.sessionId !== sessionId ||
          payload.signal?.aborted
        ) {
          payload.onConfirm(false);
          return;
        }
        paidConfirmationRef.current?.finish(false);
        const finish = (confirmed: boolean) => {
          if (paidConfirmationRef.current?.payload !== payload) return;
          paidConfirmationRef.current = null;
          setPaidConfirmationPending(false);
          payload.signal?.removeEventListener('abort', onAbort);
          payload.onConfirm(confirmed);
        };
        const onAbort = () => finish(false);
        paidConfirmationRef.current = { payload, finish };
        setPaidConfirmationPending(true);
        payload.signal?.addEventListener('abort', onAbort, { once: true });
        return;
      }
      cleanupConsent();
      if (payload.signal?.aborted) {
        setAuthConsentRequest(null);
        return;
      }
      let active = true;
      const cleanup = () => {
        active = false;
        payload.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        setAuthConsentRequest((current) =>
          current === request ? null : current,
        );
      };
      const request: ConfirmationRequest = {
        prompt: payload.prompt,
        onConfirm: (confirmed: boolean) => {
          if (!active || payload.signal?.aborted) return;
          cleanup();
          setAuthConsentRequest((current) =>
            current === request ? null : current,
          );
          payload.onConfirm(confirmed);
        },
      };
      cleanupConsent = cleanup;
      payload.signal?.addEventListener('abort', onAbort, { once: true });
      setAuthConsentRequest(request);
    };

    coreEvents.on(CoreEvent.ConsentRequest, handleConsentRequest);
    return () => {
      cleanupConsent();
      paidConfirmationRef.current?.finish(false);
      coreEvents.off(CoreEvent.ConsentRequest, handleConsentRequest);
    };
  }, [config, sessionView.sessionState.sessionId, commitItem, uiLocale]);

  // TODO(local-session-owner): expose memory-refresh actions from the local
  // session-owner path and invoke this callback from the active local branch.

  const performMemoryRefresh = useCallback(async () => {
    commitItem(
      {
        type: MessageType.INFO,
        text: 'Refreshing hierarchical memory (AGENTS.md or other context files)...',
      },
      Date.now(),
    );
    try {
      await config.getMemoryContextManager()?.refresh();
      config.updateSystemInstructionIfInitialized();
      const flattenedMemory = flattenMemory(config.getUserMemory());
      const fileCount = config.getMemoryMdFileCount();

      commitItem(
        {
          type: MessageType.INFO,
          text: `Memory reloaded successfully. ${
            flattenedMemory.length > 0
              ? `Loaded ${flattenedMemory.length} characters from ${fileCount} file(s)`
              : 'No memory content found'
          }`,
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        runLogger.log(
          `[DEBUG] Refreshed memory content in config: ${flattenedMemory.substring(
            0,
            200,
          )}...`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      commitItem(
        {
          type: MessageType.ERROR,
          text: `Error refreshing memory: ${errorMessage}`,
        },
        Date.now(),
      );
      runLogger.warn('Error refreshing memory:', error);
    }
  }, [config, commitItem]);
  void performMemoryRefresh; // Suppress TS6133 until the local session owner consumes this

  const cancelHandlerRef = useRef<(shouldRestorePrompt?: boolean) => void>(
    () => {},
  );

  const onCancelSubmit = useCallback((shouldRestorePrompt?: boolean) => {
    if (shouldRestorePrompt) {
      setPendingRestorePrompt(true);
    } else {
      setPendingRestorePrompt(false);
      cancelHandlerRef.current(false);
    }
  }, []);

  useEffect(() => {
    if (pendingRestorePrompt) {
      const lastHistoryUserMsg = historyManager.history.findLast(
        (h) => h.type === 'user',
      );
      const lastUserMsg = inputHistory.at(-1);

      if (
        !lastHistoryUserMsg ||
        (typeof lastHistoryUserMsg.text === 'string' &&
          lastHistoryUserMsg.text === lastUserMsg)
      ) {
        cancelHandlerRef.current(true);
        setPendingRestorePrompt(false);
      }
    }
  }, [pendingRestorePrompt, inputHistory, historyManager.history]);

  const { pendingHintCount, consumePendingHints } = usePendingHints(config);

  // ── Local session orchestrator + runtime projection ──
  //
  // Both hooks are always called (React rules of hooks forbid conditional calls),
  // but only the local session owner drives the UI when no session handle is supplied.

  const [sessionSystemPromptOverride, setSessionSystemPromptOverride] =
    useState<string | null>(initialSession?.systemPrompt ?? null);
  const [sessionAppendSystemPrompt, setSessionAppendSystemPrompt] = useState<
    string | null
  >(initialSession?.appendSystemPrompt ?? null);
  const [sessionDisplayTitle, setSessionDisplayTitle] = useState<
    string | undefined
  >(() => props.initialSessionTitle ?? baseConfig.topicState.getTopic());
  // The prompt border label. Only persisted custom titles reach it, never AI
  // or provisional titles; supplied sessions keep a plain border.
  const [sessionName, setSessionName] = useState<string | undefined>(() =>
    hasSessionBinding ? undefined : toSessionName(props.initialSessionTitle),
  );
  const publishSessionName = (title: string) => {
    const nextSessionName = toSessionName(title);
    if (nextSessionName && !hasSessionBinding) {
      setSessionName(nextSessionName);
    }
  };
  const sessionDisplayTitleSourceRef = useRef<SessionDisplayTitleSource>(
    props.initialSessionTitle && !props.initialSessionBrowserOptions
      ? 'custom'
      : props.initialSessionTitle
        ? 'initial'
        : baseConfig.topicState.getTopic()
          ? 'topic'
          : null,
  );
  const sessionDisplayTitleSessionIdRef = useRef(baseConfig.getSessionId());
  const resetTitleSourceIfSessionChanged = useCallback(() => {
    const currentSessionId = baseConfig.getSessionId();
    if (sessionDisplayTitleSessionIdRef.current !== currentSessionId) {
      sessionDisplayTitleSessionIdRef.current = currentSessionId;
      sessionDisplayTitleSourceRef.current = null;
    }
  }, [baseConfig]);
  // `/clear` and `/new` rotate the config session id without going through
  // the title callbacks above, so `resetTitleSourceIfSessionChanged` never
  // runs until the next user message and the terminal title keeps naming the
  // previous session. Detect the rotation while rendering (session resets
  // always re-render AppContainer) and drop the stale title so
  // `computeTerminalTitle` falls back to the brand name until the new
  // session earns its own provisional/AI title. Resume rotations pass
  // through here too and land on the brand name until the resumed session's
  // stored title is published back.
  const activeSessionIdForTitle = baseConfig.getSessionId();
  if (sessionDisplayTitleSessionIdRef.current !== activeSessionIdForTitle) {
    sessionDisplayTitleSessionIdRef.current = activeSessionIdForTitle;
    sessionDisplayTitleSourceRef.current = null;
    setSessionDisplayTitle(undefined);
    setSessionName(undefined);
  }
  // A resumed or branched session publishes its stored custom title as soon as
  // the runtime switches, instead of waiting for the first turn's republish.
  // An unnamed resume changes nothing: marking the source 'custom' without a
  // title would stop AI titles from ever landing for that session.
  resumedCustomTitleTapRef.current = (title, sessionId) => {
    if (!title || hasSessionBinding) {
      return;
    }
    sessionDisplayTitleSessionIdRef.current = sessionId;
    sessionDisplayTitleSourceRef.current = 'custom';
    setSessionDisplayTitle(title);
    publishSessionName(title);
  };

  const runtimeProjectionRef = useRef<RuntimeProjectionController>(
    NOOP_RUNTIME_PROJECTION,
  );
  const [modelNextActionSuggestions, setModelNextActionSuggestions] =
    useState<ModelNextActionSuggestions | null>(null);
  const promptSuggestionEnabled =
    settings.merged.promptSuggestionEnabled !== false;
  const modelNextActionSuggestionIdRef = useRef(0);
  const clearModelNextActionSuggestions = useCallback(() => {
    setModelNextActionSuggestions(null);
  }, []);
  useEffect(() => {
    if (!promptSuggestionEnabled) {
      clearModelNextActionSuggestions();
    }
  }, [clearModelNextActionSuggestions, promptSuggestionEnabled]);
  const handlePromptSuggestions = useCallback(
    (suggestions: readonly string[], promptId: string) => {
      if (!promptSuggestionEnabled) {
        clearModelNextActionSuggestions();
        return;
      }
      const items = suggestions
        .map((suggestion) => suggestion.trim())
        .filter(Boolean)
        .slice(0, 1);
      setModelNextActionSuggestions(
        items.length > 0
          ? {
              id: ++modelNextActionSuggestionIdRef.current,
              promptId,
              items,
            }
          : null,
      );
    },
    [clearModelNextActionSuggestions, promptSuggestionEnabled],
  );
  const visibleModelNextActionSuggestions = promptSuggestionEnabled
    ? modelNextActionSuggestions
    : null;
  const slashCommandsRef = useRef<Parameters<typeof parseSlashCommand>[1]>([]);
  const slashCommandCatalogReadyRef = useRef(false);
  const classifySlashCommandInput = useCallback((input: string): boolean => {
    const commands = slashCommandsRef.current;
    const parsed = parseSlashCommand(input, commands);
    return isSlashCommand(input.trim(), {
      isKnownCommand: Boolean(parsed.commandToExecute),
      commandCatalogReady: slashCommandCatalogReadyRef.current,
    });
  }, []);
  const slashCommandHandlerRef = useRef<
    | ((
        input: string,
        oneTimeShellAllowlist?: Set<string>,
        overwriteConfirmed?: boolean,
        addToHistory?: boolean,
        skipProcessingLock?: boolean,
        pastedContents?: Record<number, PastedContent>,
      ) => Promise<SlashCommandProcessorResult | false>)
    | null
  >(null);
  const shellCommandHandlerRef = useRef<
    | ((
        input: string,
        signal: AbortSignal,
      ) => Promise<BashCommandOutcome | false>)
    | null
  >(null);
  const shellAbortControllerRef = useRef<AbortController>(
    new AbortController(),
  );
  const localOrchestrator = useLocalTuiSessionOrchestrator({
    config: baseConfig,
    displayHistory: historyManager.history,
    getDisplayPendingHistory: () => pendingDisplayHistoryItems,
    setSystemPrompt: setSessionSystemPromptOverride,
    setAppendSystemPrompt: setSessionAppendSystemPrompt,
    permissionQueue: permissionQueueStore,
    isReadyForSessionInput: () => canExecuteLocalInput && isMcpReady,
    restoreSession: resumeSessionFromCommands,
    settings,
    addItem: historyManager.addItem,
    getPreferredEditor,
    onCancelSubmit,
    focusMachine,
    onPromptSuggestions: handlePromptSuggestions,
    onProvisionalSessionTitle: (submittedPrompt) => {
      resetTitleSourceIfSessionChanged();
      if (sessionDisplayTitleSourceRef.current !== null) {
        return;
      }
      const provisionalTitle = createProvisionalTerminalTitle(submittedPrompt);
      if (!provisionalTitle) {
        return;
      }
      sessionDisplayTitleSourceRef.current = 'provisional';
      setSessionDisplayTitle(provisionalTitle);
    },
    onLocalSessionTitle: (title) => {
      sessionDisplayTitleSessionIdRef.current = baseConfig.getSessionId();
      sessionDisplayTitleSourceRef.current = 'custom';
      setSessionDisplayTitle(title);
      publishSessionName(title);
    },
    onLocalAiTitle: (title, origin) => {
      resetTitleSourceIfSessionChanged();
      if (origin === 'existing-custom') {
        sessionDisplayTitleSourceRef.current = 'custom';
        setSessionDisplayTitle(title);
        publishSessionName(title);
      } else if (sessionDisplayTitleSourceRef.current !== 'custom') {
        sessionDisplayTitleSourceRef.current = 'ai';
        setSessionDisplayTitle(title);
      }
    },
    onStartupWaitingChange: setIsStartupWaiting,
    systemPromptOverride: sessionSystemPromptOverride,
    appendSystemPrompt: sessionAppendSystemPrompt,
    initialConversationHistory:
      props.sessionUi?.session.getConversationMessages() ??
      props.sessionUi?.session.getMessages() ??
      undefined,
    deferInitialTranscriptWriter: resumedSessionData !== undefined,
    initialSessionTitle: props.initialSessionBrowserOptions
      ? undefined
      : props.initialSessionTitle,
    version: props.version,
    gitBranch: branchName,
    runtimeProjectionRef,
    isSlashCommandInput: classifySlashCommandInput,
    onSlashCommand: async (input, pastedContents) => {
      const result = await (slashCommandHandlerRef.current?.(
        input,
        undefined,
        undefined,
        true,
        false,
        pastedContents,
      ) ?? Promise.resolve(false));
      if (result !== false && result !== undefined) {
        return result;
      }

      const unknownCommandName = getUnknownSlashCommandName(
        input,
        slashCommandsRef.current,
      );
      if (!unknownCommandName) {
        return false;
      }

      const message = `Unknown skill: ${unknownCommandName}`;
      return {
        messages: [createSystemMessage('error', message, 'error')],
        shouldQuery: false,
        resultText: message,
        resultIsError: true,
      } satisfies ProcessInputResult;
    },
    onBridgeSlashCommand: (input) =>
      getBridgeSlashCommandDecision(input, slashCommandsRef.current),
    onBashCommand: async (input) =>
      (await shellCommandHandlerRef.current?.(
        input,
        shellAbortControllerRef.current.signal,
      )) ?? false,
    awaitSessionStartHooks,
  });
  disposeLocalSessionRef.current = localOrchestrator.dispose;
  const localProjection = useRuntimeProjection({
    config: baseConfig,
    settings,
    addItem: historyManager.addItem,
    getPreferredEditor,
  });
  // Must stay synchronous during render so submitQuery always sees the latest
  // projection controller on the same render pass.
  runtimeProjectionRef.current = localProjection.controller;

  const getLocalSession = localOrchestrator.getSession;
  useLayoutEffect(() => {
    if (hasSessionBinding || !isConfigInitialized) return;
    const session = getLocalSession();
    const binding = createSessionUiBinding(session, 'local');
    void session.start();
    const unbind = application?.bindLocalSession?.(session);
    setLocalSessionBinding({ config: baseConfig, binding });
    return () => {
      unbind?.();
      void binding
        .dispose()
        .catch((error) =>
          runLogger.warn('[local-session] UI binding cleanup failed', error),
        );
    };
  }, [
    baseConfig,
    hasSessionBinding,
    isConfigInitialized,
    application,
    getLocalSession,
  ]);

  useEffect(() => {
    if (!hasSessionBinding || !sessionView.sessionTitle) {
      return;
    }
    sessionDisplayTitleSessionIdRef.current = baseConfig.getSessionId();
    sessionDisplayTitleSourceRef.current = 'initial';
    setSessionDisplayTitle(sessionView.sessionTitle);
  }, [baseConfig, hasSessionBinding, sessionView.sessionTitle]);

  const submitSessionQuery = sessionView.submitQuery;
  const sessionSubmitUserInput = useCallback(
    async (input: string, options?: SubmitUserInputOptions) =>
      submitSessionQuery(
        input,
        localSession ? options : { pastedContents: options?.pastedContents },
      ),
    [submitSessionQuery, localSession],
  );

  // Both session kinds use the same UI consumers. Native-only operations retain
  // their original executor; the fallback also serves pre-binding local commands.
  const activeLoop = {
    streamingState: hasUiSession
      ? sessionView.streamingState
      : localProjection.streamingState,
    isModelTurnActive: hasUiSession
      ? sessionView.isModelTurnActive
      : localProjection.isModelTurnActive,
    submitUserInput: hasUiSession
      ? sessionSubmitUserInput
      : localOrchestrator.submitUserInput,
    pendingHistoryItems: hasUiSession
      ? sessionView.pendingHistoryItems
      : localProjection.pendingHistoryItems,
    activeModelQueue: hasUiSession
      ? sessionView.activeModelQueue
      : localOrchestrator.activeModelQueue,
    thought: hasUiSession ? sessionView.thought : localProjection.thought,
    cancelOngoingRequest: hasSessionBinding
      ? () => sessionView.cancelOngoingRequest()
      : hasUiSession
        ? sessionView.cancelOngoingRequest
        : localOrchestrator.cancelOngoingRequest,
    handlePermissionModeChange: hasUiSession
      ? sessionView.handlePermissionModeChange
      : localOrchestrator.handlePermissionModeChange,
    getIsResponding: hasUiSession
      ? sessionView.getIsResponding
      : localOrchestrator.getIsResponding,
    getConversationMessages: hasUiSession
      ? sessionView.getConversationMessages
      : localOrchestrator.getConversationMessages,
    getMessages: hasUiSession
      ? sessionView.getMessages
      : localOrchestrator.getMessages,
    setMessages: hasUiSession
      ? sessionView.setMessages
      : localOrchestrator.setMessages,
    replaceMessages: hasUiSession
      ? sessionView.replaceMessages
      : localOrchestrator.replaceMessages,
    ...(hasSessionBinding
      ? {
          submitQuery: sessionView.submitQuery,
          pendingToolCalls: [] as TrackedToolCall[],
          queueHookContext: NOOP_QUEUE_HOOK_CONTEXT,
          recordSupplementaryHistoryItem:
            sessionView.recordSupplementaryHistoryItem,
          recordMessage: sessionView.recordMessage,
          runManualCompress:
            sessionView.runManualCompress as unknown as RunManualCompress,
          ensurePromptBuildResult: undefined,
          externalImportApprovalState: EMPTY_EXTERNAL_IMPORT_STATE,
          handleExternalImportApproval: NOOP_HANDLE_EXTERNAL_IMPORT_APPROVAL,
          clearAssemblerCache: () => {},
        }
      : {
          submitQuery: localOrchestrator.submitQuery,
          pendingToolCalls: localProjection.pendingToolCalls,
          queueHookContext: localOrchestrator.queueHookContext,
          recordSupplementaryHistoryItem:
            localOrchestrator.recordSupplementaryHistoryItem,
          clearAssemblerCache: localOrchestrator.clearAssemblerCache,
          recordMessage: localOrchestrator.recordMessage,
          runManualCompress: localOrchestrator.runManualCompress,
          ensurePromptBuildResult: localOrchestrator.ensurePromptBuildResult,
          externalImportApprovalState:
            localOrchestrator.externalImportApprovalState,
          handleExternalImportApproval:
            localOrchestrator.handleExternalImportApproval,
        }),
  };

  const {
    streamingState: rawStreamingState,
    isModelTurnActive,
    submitUserInput,
    submitQuery,
    pendingHistoryItems: pendingGeminiHistoryItems,
    activeModelQueue,
    thought,
    cancelOngoingRequest,
    handlePermissionModeChange,
    getIsResponding,
    getMessages,
    setMessages,
    replaceMessages,
    queueHookContext,
    recordSupplementaryHistoryItem,
    clearAssemblerCache,
    recordMessage,
    runManualCompress,
    ensurePromptBuildResult,
    externalImportApprovalState,
    handleExternalImportApproval,
  } = activeLoop;
  const devModelQueue = useModelQueueDevScenario();
  const displayedActiveModelQueue = devModelQueue ?? activeModelQueue;
  // Restore also carries session identity and transcript options on the native path.
  replaceRunLoopMessagesRef.current = hasSessionBinding
    ? replaceMessages
    : localOrchestrator.replaceMessages;
  refreshContextTokenCountRef.current =
    localOrchestrator.refreshContextTokenCount;

  // Promote streamingState while an asynchronous slash command owns the turn.
  // Model-specific loading UI is gated separately by model turn ownership.
  const streamingState =
    isProcessing && rawStreamingState === StreamingState.Idle
      ? StreamingState.Responding
      : rawStreamingState;

  // Publishes activity into the peer registry so another session's `ListAgents`
  // reports whether this one can take work now. No-ops unless a peer socket was
  // bound, and writes only on a transition.
  useSessionRegistryStatus(streamingState, shellModeActive);

  // ── Cron scheduler isLoading bridge ─────────────────────────────────────────
  // Tell this session's cron manager when its agent is busy. The ref ensures the
  // callback always reads the latest value.
  const streamingStateRef = useRef(streamingState);
  streamingStateRef.current = streamingState;
  const rewindReadinessRef = useRef({
    isProcessing,
  });
  rewindReadinessRef.current = {
    isProcessing,
  };
  const addCronHistoryItem = historyManager.addItem;
  const cronManager = baseConfig.getCronManager();
  useEffect(() => {
    cronManager.setIsLoadingProvider(
      () => streamingStateRef.current !== StreamingState.Idle,
    );

    // No sessionId provider to register: the manager reads it from this Config on
    // every ownership check, so session rotations (/resume, /clear, fork) are
    // picked up without restarting the scheduler. That used to need an external
    // registration, and every path that skipped it — headless, daemon — silently
    // froze on the id the scheduler started with.

    // Restore persisted cron tasks on startup. The scheduler is otherwise
    // only lazily started by CronCreate, which means scheduled tasks created
    // in a previous session would never resume after a restart. We probe the
    // task file synchronously and bring the scheduler up before any user
    // interaction occurs (interactive mode only — headless `-p` runs are
    // intentionally unaffected since AppContainer is not mounted there).
    const taskCount = countCronTasksSync();
    if (taskCount > 0) {
      cronManager.ensureStarted();
      // Show feedback about restored tasks
      setTimeout(() => {
        addCronHistoryItem(
          {
            type: MessageType.INFO,
            text: `${taskCount} scheduled task${taskCount > 1 ? 's' : ''} found — /crontab to view and claim.`,
          },
          Date.now(),
        );
      }, 500);
    }

    return () => {
      // Detach on unmount / Config change. The provider closes over this
      // component's refs; leaving it registered would have the next Config's
      // scheduler defer its fires on a stale component's streaming state.
      cronManager.setIsLoadingProvider(null);
    };
  }, [addCronHistoryItem, cronManager]);

  // QueryGuard for concurrency control.
  // A single instance lives for the lifetime of the component.
  const queryGuardRef = useRef(new QueryGuard());
  const queryGuard = queryGuardRef.current;

  // Sync QueryGuard state with StreamingState.
  // When a query starts (non-idle), tryStart() marks the guard as running.
  // When a query ends (idle), end() releases the guard so the queue processor
  // can pick up the next item.
  const prevStreamingStateRef = useRef(streamingState);
  useEffect(() => {
    const prev = prevStreamingStateRef.current;
    prevStreamingStateRef.current = streamingState;

    if (
      prev === StreamingState.Idle &&
      streamingState !== StreamingState.Idle
    ) {
      // Transition to non-idle: mark query as running
      runLogger.debug(`[QueryGuard] tryStart: ${prev} -> ${streamingState}`);
      queryGuard.tryStart();
    } else if (
      prev !== StreamingState.Idle &&
      streamingState === StreamingState.Idle
    ) {
      // Transition to idle: release the guard
      runLogger.debug(`[QueryGuard] forceEnd: ${prev} -> ${streamingState}`);
      queryGuard.forceEnd();
    }
  }, [streamingState, queryGuard]);

  // ── Goal pause/clear cancellation ──────────────────────────────────────────
  // When a goal is paused or cleared while the agent is running, abort the
  // current turn so the user regains control immediately.
  const cancelOngoingRequestRef = useRef(cancelOngoingRequest);
  cancelOngoingRequestRef.current = cancelOngoingRequest;

  useEffect(() => {
    const handleGoalUpdated = (payload: {
      goal: { status: string; turnsUsed: number; maxTurns?: number };
      reason?: string;
    }) => {
      if (payload.goal.status === 'paused') {
        cancelOngoingRequestRef.current?.();
        // Hard-turn-limit auto-pause happens without any user action — surface
        // it in the conversation feed so the user knows why the goal stopped
        // and how to continue.
        if (payload.reason === 'safety-limit') {
          historyManager.addItem(
            {
              type: 'info',
              text: `Goal auto-paused: reached the turn limit (${payload.goal.turnsUsed}${payload.goal.maxTurns ? `/${payload.goal.maxTurns}` : ''} turns). Use /goal resume to continue (grants a fresh block of turns), or /goal clear to drop it.`,
            },
            Date.now(),
          );
        }
      }
    };
    const handleGoalCleared = (payload: { reason?: string }) => {
      // When the goal completes naturally (via update_goal tool), the agent
      // loop will end on its own through the stop hook — no need to cancel.
      if (payload.reason === 'completed') return;
      cancelOngoingRequestRef.current?.();
    };
    coreEvents.on(CoreEvent.GoalUpdated, handleGoalUpdated);
    coreEvents.on(CoreEvent.GoalCleared, handleGoalCleared);
    return () => {
      coreEvents.off(CoreEvent.GoalUpdated, handleGoalUpdated);
      coreEvents.off(CoreEvent.GoalCleared, handleGoalCleared);
    };
  }, [historyManager]);

  // Adapter: dispatch QueuedCommand[] batches to submitUserInput or submitQuery.
  // processQueueIfReady batches commands by same commandMode, so commands[0]
  // is representative of the entire batch.
  const executeQueuedInput = useCallback(
    async (commands: QueuedCommand[]) => {
      runLogger.debug(
        `[executeQueuedInput] called with ${commands.length} commands: ` +
          commands.map((c) => `${c.commandMode}`).join(', '),
      );
      const textParts = commands
        .map((cmd) => (typeof cmd.prompt === 'string' ? cmd.prompt : ''))
        .filter(Boolean);
      if (textParts.length === 0) {
        runLogger.debug('[executeQueuedInput] no text parts, skipping');
        return;
      }
      const combinedText = textParts.join('\n\n');
      runLogger.debug(
        `[executeQueuedInput] submitting query, textLen=${combinedText.length}`,
      );

      // User prompts go through submitUserInput — renders the User Message
      // bubble and triggers permission checks (matching pre-unification behavior).
      // Internal commands (task-notification, etc.) stay hidden from the UI.
      if (commands[0] && isUserPrompt(commands[0])) {
        await submitUserInput(combinedText, {
          queuedCommands: commands,
        });
      } else {
        // Show internal agent messages before the model processes them.
        for (const cmd of commands) {
          if (
            !cmd.targetAgentId &&
            (cmd.sessionId === undefined ||
              cmd.sessionId === config.getSessionId())
          ) {
            const text =
              typeof cmd.prompt === 'string'
                ? cmd.prompt
                : Array.isArray(cmd.prompt)
                  ? (cmd.prompt as Array<{ type: string; text?: string }>)
                      .filter(
                        (b): b is { type: 'text'; text: string } =>
                          b.type === 'text' && typeof b.text === 'string',
                      )
                      .map((b) => b.text)
                      .join('')
                  : '';
            if (text) {
              // `kind === 'peer'` covers both in-process teammate mailbox
              // messages and cross-session ones; only the latter sets
              // `transport`, and only it renders as a peer row.
              const peerOrigin =
                cmd.origin?.kind === 'peer' ? cmd.origin : undefined;
              const item =
                cmd.commandMode === 'task-notification'
                  ? buildTaskNotificationHistoryItem(text)
                  : peerOrigin?.transport === 'uds'
                    ? buildPeerMessageHistoryItem({
                        text,
                        origin: peerOrigin,
                        ...(cmd.displaySummary !== undefined && {
                          displaySummary: cmd.displaySummary,
                        }),
                      })
                    : peerOrigin
                      ? buildTeammateMessageHistoryItem(
                          text,
                          cmd.displaySummary,
                          cmd.displayColor,
                        )
                      : null;
              if (item) historyManager.addItem(item);
            }
          }
        }
        await submitQuery([{ text: combinedText }], {
          hideFromDisplay: true,
          useInputProcessor: true,
          queuedCommands: commands,
          stopHookActive: commands.some((cmd) => cmd.stopHookActive),
        });
      }
    },
    [config, submitQuery, submitUserInput, historyManager],
  );

  queueHookContextRef.current = queueHookContext;
  recordSupplementaryHistoryRef.current = recordSupplementaryHistoryItem;
  autoMemoryMessagesRef.current = () => (getMessages ? getMessages() : []);

  const rewindConversationToMessage = useCallback(
    async (candidate: RewindCandidate) => {
      if (hasSessionBinding) {
        throw new ConversationRewindError(
          'not-ready',
          'Conversation rewind is unavailable for this session.',
        );
      }

      if (!queryGuard.reserve()) {
        const error = new ConversationRewindError(
          'not-ready',
          'Cannot rewind while another query is active.',
        );
        setQueueErrorMessage(error.message);
        throw error;
      }

      const queueRevision = getCommandQueueRevision();
      const previousHistory = [...historyManager.history];
      const previousBufferText = bufferRef.current?.text ?? '';
      const previousShellModeActive = shellModeActive;
      const assertReady = () => {
        const currentReadiness = rewindReadinessRef.current;
        if (getIsResponding() || currentReadiness.isProcessing) {
          throw new ConversationRewindError(
            'not-ready',
            'Cannot rewind while the current turn is still active.',
          );
        }
        if (
          getCommandQueueRevision() !== queueRevision ||
          getCommandQueue().some(
            (command) => command.targetAgentId === undefined,
          )
        ) {
          throw new ConversationRewindError(
            'not-ready',
            'Cannot rewind while another main-thread command is queued.',
          );
        }
      };

      try {
        await localOrchestrator.rewindConversation(candidate.message.uuid, {
          getExternalRevision: getCommandQueueRevision,
          assertReady,
          commitView: (plan) => {
            const historyData = convertMessagesToHistoryFormats([
              ...plan.retainedMessages,
            ]);
            historyManager.clearItems();
            historyData.uiHistory.forEach((item, index) => {
              historyManager.addItem(item, index, true);
            });
            setShellModeActive(plan.target.inputMode === 'bash');
            bufferRef.current?.setText(plan.target.prefillText, 'end', {
              pushToUndo: false,
            });
          },
          restoreView: () => {
            historyManager.loadHistory(previousHistory);
            setShellModeActive(previousShellModeActive);
            bufferRef.current?.setText(previousBufferText, 'end', {
              pushToUndo: false,
            });
          },
        });
      } finally {
        queryGuard.cancelReservation();
      }
    },
    [
      getIsResponding,
      historyManager,
      hasSessionBinding,
      localOrchestrator,
      queryGuard,
      setQueueErrorMessage,
      shellModeActive,
    ],
  );

  const rewindLocalFiles = localOrchestrator.rewindFiles;
  const openRewindDialog = useCallback(() => {
    if (hasSessionBinding) {
      setQueueErrorMessage(
        'Conversation rewind is unavailable for this session.',
      );
      return;
    }
    const runtimeMessages = getMessages?.() ?? [];
    const messages = getRewindCandidates(runtimeMessages);
    const fileHistory = config.getFileHistoryManager();

    setCustomDialog(
      <RewindDialog
        messages={messages}
        allMessages={runtimeMessages}
        fileHistory={fileHistory}
        onClose={() => setCustomDialog(null)}
        onRestoreConversation={rewindConversationToMessage}
        onRestoreFiles={async (candidate) => {
          if (!fileHistory) {
            return;
          }
          const result = await rewindLocalFiles(candidate.message.uuid);
          const failure = formatFileHistoryRewindFailure(result);
          if (failure) throw new Error(failure);
        }}
        onRestoreBoth={async (candidate) => {
          const result = fileHistory
            ? await rewindLocalFiles(candidate.message.uuid)
            : undefined;
          await rewindConversationToMessage(candidate);
          const failure = result && formatFileHistoryRewindFailure(result);
          if (failure) {
            setQueueErrorMessage(`Conversation was restored. ${failure}`);
          }
        }}
        onBackgroundError={setQueueErrorMessage}
      />,
    );
  }, [
    config,
    getMessages,
    hasSessionBinding,
    rewindConversationToMessage,
    rewindLocalFiles,
    setQueueErrorMessage,
  ]);
  openRewindDialogRef.current = openRewindDialog;

  useEffect(() => {
    if (hasSessionBinding) {
      setCurrentModel(sessionView.currentModel);
      setCurrentReasoningEffort(sessionView.currentReasoningEffort);
      setCurrentContextWindow(sessionView.currentContextWindow);
    }
  }, [
    hasSessionBinding,
    sessionView.currentModel,
    sessionView.currentReasoningEffort,
    sessionView.currentContextWindow,
    setCurrentModel,
    setCurrentReasoningEffort,
    setCurrentContextWindow,
  ]);

  // Local sessions keep their own view state, which the proxy-based model
  // events cannot refresh; mirror programmatic switches into it so the status
  // line follows auth activation and SDK model changes.
  useEffect(() => {
    if (!hasSessionBinding) {
      setCurrentModel(sessionView.currentModel);
    }
  }, [hasSessionBinding, sessionView.currentModel, setCurrentModel]);

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
    confirmationRequest: commandConfirmationRequest,
    activeProgressMessage: slashCommandProgressMessage,
    triggerCancellableCallbacks,
  } = useSlashCommandProcessor(
    uiConfig,
    settings,
    historyManager.addItem,
    historyManager.updateItem,
    historyManager.clearItems,
    historyManager.loadHistory,
    (messages, sessionId) =>
      replaceRunLoopMessagesRef.current(messages, sessionId),
    resumeSessionFromCommands,
    clearConversation,
    replaceConversation,
    toggleVimEnabled,
    setIsProcessing,
    slashCommandActions,
    extensionsUpdateStateInternal,
    isConfigInitialized,
    setCustomDialogGuarded,
    setFullScreenDialog,
    getMessages,
    setMessages,
    clearAssemblerCache,
    recordMessage,
    runManualCompress,
    ensurePromptBuildResult,
    queueHookContext,
    hasSessionBinding ? sessionView.sessionHandle : undefined,
  );

  const compressionProgress = useCompressionProgress(config.getSessionId());
  slashCommandHandlerRef.current = handleSlashCommand;
  slashCommandsRef.current = slashCommands ?? [];
  slashCommandCatalogReadyRef.current = slashCommands !== undefined;

  // ── Shell execution lifecycle (drives shell mode + background tasks) ──
  const [pendingShellHistoryItem, setPendingShellHistoryItem] =
    useState<HistoryItemWithoutId | null>(null);

  const foregroundToolExecutionIds = useMemo(() => {
    const executionIds = new Set<number>();
    for (const item of pendingGeminiHistoryItems) {
      if (item.type !== 'tool_group') {
        continue;
      }
      for (const tool of item.tools) {
        if (tool.status !== CoreToolCallStatus.Executing) {
          continue;
        }
        if (typeof tool.executionId === 'number') {
          executionIds.add(tool.executionId);
        }
      }
    }
    return [...executionIds];
  }, [pendingGeminiHistoryItems]);

  const { handleShellCommand, activeShellId, backgroundForegroundExecutions } =
    useExecutionLifecycle(
      historyManager.addItem,
      setPendingShellHistoryItem,
      setDebugMessage,
      config,
      focusMachine,
      terminalWidth,
      terminalHeight,
      foregroundToolExecutionIds,
      undefined, // isWaitingForConfirmation
    );
  shellCommandHandlerRef.current = handleShellCommand;

  const retryStatus = null;

  const backgroundAgentWaitingItem = useMemo(
    () =>
      buildBackgroundAgentWaitingItem({
        tasks: visibleUnifiedTasks,
        streamingState,
      }),
    [visibleUnifiedTasks, streamingState],
  );
  useEffect(() => {
    if (backgroundAgentWaitingItem) {
      appEvents.emit(AppEvent.ScrollToBottom);
    }
  }, [backgroundAgentWaitingItem]);

  // Keep the internal pending-compaction lock marker out of conversation
  // history; CompressionProgressIndicator renders its visible state instead.
  const visiblePendingSlashCommandHistoryItems = useMemo(
    () =>
      pendingSlashCommandHistoryItems.filter(
        (item) => !isPendingCompactionMarker(item),
      ),
    [pendingSlashCommandHistoryItems],
  );

  const pendingHistoryItems = useMemo(
    () => [
      ...visiblePendingSlashCommandHistoryItems,
      ...pendingGeminiHistoryItems,
      ...(backgroundAgentWaitingItem ? [backgroundAgentWaitingItem] : []),
      ...(pendingShellHistoryItem ? [pendingShellHistoryItem] : []),
    ],
    [
      visiblePendingSlashCommandHistoryItems,
      pendingGeminiHistoryItems,
      backgroundAgentWaitingItem,
      pendingShellHistoryItem,
    ],
  );

  // Model queue status is a foreground model phase, not conversation content.
  // Keep wrapping it only at the session display boundary so older controllers
  // can continue receiving the existing pending-snapshot wire shape.
  const pendingDisplayHistoryItems = useMemo(
    () => [
      ...visiblePendingSlashCommandHistoryItems,
      ...(activeModelQueue
        ? [
            {
              type: MessageType.MODEL_QUEUE as const,
              modelQueue: activeModelQueue,
            },
          ]
        : []),
      ...pendingGeminiHistoryItems,
      ...(backgroundAgentWaitingItem ? [backgroundAgentWaitingItem] : []),
      ...(pendingShellHistoryItem ? [pendingShellHistoryItem] : []),
    ],
    [
      visiblePendingSlashCommandHistoryItems,
      activeModelQueue,
      pendingGeminiHistoryItems,
      backgroundAgentWaitingItem,
      pendingShellHistoryItem,
    ],
  );

  const handlePermissionModeChangeWithUiReveal = useCallback(
    (mode: PermissionMode) => {
      if (!hasUiSession) {
        void handlePermissionModeChange(mode);
      }
      if (!cleanUiDetailsVisible) {
        revealCleanUiDetailsTemporarily(PERMISSION_MODE_REVEAL_DURATION_MS);
      }
    },
    [
      hasUiSession,
      handlePermissionModeChange,
      cleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
    ],
  );

  const { isMcpReady, needsAuthServerCount } = useMcpStatus(config);
  const mcpAuthNotice = useMcpAuthHeaderNotice(
    config,
    shouldEnableMcpAuthHeaderNotice(isConfigInitialized, hasSessionBinding),
    needsAuthServerCount,
  );
  const canSubmitPrompt = isConfigInitialized;
  const canExecuteLocalInput =
    canSubmitPrompt &&
    !isProcessing &&
    !isResuming &&
    !isSelectingInitialSession &&
    !isAutomaticInputBlocked;
  const canUseMcpTools = isConfigInitialized && isMcpReady;

  // Drain queued commands when the model is idle.
  useQueueProcessor({
    executeQueuedInput,
    queryGuard,
    isReady: canExecuteLocalInput,
  });

  const shouldSkipSlashCommandsForQueuedPrompt = useCallback(
    (message: string): boolean => {
      const trimmed = message.trim();
      if (!trimmed.startsWith('/')) {
        return false;
      }
      const parsed = parseSlashCommand(trimmed, slashCommands ?? []);
      return !isSlashCommand(trimmed, {
        isKnownCommand: Boolean(parsed.commandToExecute),
        commandCatalogReady: slashCommands !== undefined,
      });
    },
    [slashCommands],
  );

  const {
    messageQueue,
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
  } = useUserMessageQueue(shouldSkipSlashCommandsForQueuedPrompt);

  // Send-now: InputPrompt has already queued the draft (synchronously) and
  // only calls this while a local model turn is responding. Read the live
  // queue rather than the `messageQueue` projection, which is one render
  // behind that enqueue. cancelOngoingRequest keeps the queue intact, so it
  // drains as the next turn once the stream goes idle.
  const sendQueuedNow = useCallback(() => {
    if (!getCommandQueueSnapshot().some(isUserPrompt)) return;
    cancelOngoingRequest?.();
  }, [cancelOngoingRequest]);

  cancelHandlerRef.current = useCallback(
    (shouldRestorePrompt: boolean = true) => {
      if (isToolAwaitingConfirmation(pendingHistoryItems)) {
        return; // Don't clear - user may be composing a follow-up message
      }

      // If cancelling (shouldRestorePrompt=false), never modify the buffer.
      // ESC uses this path to abort a running turn, and the user's draft is
      // separate state from the turn being cancelled.
      if (!shouldRestorePrompt) {
        return;
      }

      if (isToolExecuting(pendingHistoryItems)) {
        bufferRef.current?.setText(''); // Clear for Ctrl+C cancellation
        return;
      }

      // Restore the last message when shouldRestorePrompt=true
      const lastUserMessage = inputHistory.at(-1);
      let textToSet = lastUserMessage || '';

      const queuedText = getQueuedMessagesText();
      if (queuedText) {
        textToSet = textToSet ? `${textToSet}\n\n${queuedText}` : queuedText;
        clearQueue();
      }

      if (textToSet) {
        bufferRef.current?.setText(textToSet);
      }
    },
    [inputHistory, getQueuedMessagesText, clearQueue, pendingHistoryItems],
  );

  const handleHintSubmit = useCallback(
    (hint: string) => {
      const trimmed = hint.trim();
      if (!trimmed) {
        return;
      }
      config.injectionService.addInjection(trimmed, 'user_steering');
      // Render hints with a distinct style.
      commitItem({
        type: 'hint',
        text: trimmed,
      });
    },
    [config, commitItem],
  );

  const handleFinalSubmit = useCallback(
    async (
      submittedValue: string,
      imagePastedContents: Record<number, PastedContent> = {},
      preExpansionText?: string,
      slashCommandSource: import('@qwen-code/core').SlashCommandSource = 'typed',
      suppressWorkflowKeyword?: boolean,
      allowAutomaticInputRecovery = false,
    ) => {
      const paid = paidConfirmationRef.current;
      if (paid) {
        if (
          /^(?:\/)?continue$/i.test(submittedValue.trim()) &&
          (slashCommandSource === 'typed' || slashCommandSource === 'menu') &&
          paid.payload.modelPaid?.model === uiConfig.getModel()
        ) {
          paid.finish(true);
          addInput(submittedValue);
        }
        return;
      }
      reset();
      clearModelNextActionSuggestions();
      // Explicitly hide the expansion hint and clear its x-second timer when a new turn begins.
      triggerExpandHint(null);
      if (!constrainHeight) {
        resetToConstrained();
      }

      const trimmedSubmittedValue = submittedValue.trim();
      if (trimmedSubmittedValue) {
        // Arrow-key prompt history still reads from logger-backed input history.
        // Fire-and-forget: input history persistence should not block submission.
        void logger?.logMessage(MessageSenderType.USER, trimmedSubmittedValue);
      }

      const parsedSlashCommand = parseSlashCommand(
        trimmedSubmittedValue,
        slashCommands ?? [],
      );
      const isSlash = isSlashCommand(trimmedSubmittedValue, {
        isKnownCommand: Boolean(parsedSlashCommand.commandToExecute),
        commandCatalogReady: slashCommands !== undefined,
      });
      const isIdle = streamingState === StreamingState.Idle;
      const slashCommandToExecute = isSlash
        ? parsedSlashCommand.commandToExecute
        : undefined;

      if (slashCommandToExecute?.isSafeConcurrent) {
        void handleSlashCommand(
          submittedValue,
          undefined,
          undefined,
          true,
          true, // skipProcessingLock: safe local commands should not show Thinking.
          imagePastedContents,
        );
        addInput(submittedValue);
        return;
      }

      const localInputReady =
        canExecuteLocalInput ||
        (allowAutomaticInputRecovery && !isProcessing && !isResuming);
      if (
        localInputReady &&
        config.isModelSteeringEnabled() &&
        isModelTurnActive &&
        !isSlash
      ) {
        handleHintSubmit(submittedValue);
        addInput(submittedValue);
        return;
      }

      const canSubmitNow =
        localInputReady || (isSlash && isIdle && !shellModeActive);
      if (canSubmitNow && (isSlash || isIdle)) {
        if (!isSlash && shellModeActive) {
          shellAbortControllerRef.current = new AbortController();
          void submitUserInput(submittedValue.trim(), {
            commandMode: 'bash',
          });
        } else {
          void submitUserInput(submittedValue, {
            pastedContents: imagePastedContents,
            suppressWorkflowKeyword,
          });
        }
      } else {
        // Check hasCommandsInQueue to only notify on the first queued item
        if (isIdle && !canSubmitPrompt && !hasCommandsInQueue()) {
          coreEvents.emitFeedback(
            'info',
            'Initializing... Prompts will be queued.',
          );
        }
        addMessage(submittedValue, {
          pastedContents: imagePastedContents,
          preExpansionText,
          suppressWorkflowKeyword,
        });
      }
      addInput(submittedValue); // Track input for up-arrow history
    },
    [
      uiConfig,
      addMessage,
      addInput,
      submitUserInput,
      handleSlashCommand,
      slashCommands,
      canSubmitPrompt,
      canExecuteLocalInput,
      streamingState,
      isModelTurnActive,
      isProcessing,
      isResuming,
      config,
      constrainHeight,
      resetToConstrained,
      reset,
      clearModelNextActionSuggestions,
      handleHintSubmit,
      triggerExpandHint,
      logger,
      shellModeActive,
    ],
  );

  const handleClearScreen = useCallback(() => {
    reset();
    // Explicitly hide the expansion hint and clear its x-second timer when clearing the screen.
    triggerExpandHint(null);
    historyManager.clearItems();
    clearErrorCount();
    clearConversation();
  }, [
    historyManager,
    clearErrorCount,
    clearConversation,
    reset,
    triggerExpandHint,
  ]);

  // Preserve compaction's existing stash-restoration behavior while the
  // summary generates. Its internal COMPRESSION marker is filtered out of
  // displayed history above.
  const isCompacting = useMemo(
    () => pendingSlashCommandHistoryItems.some(isPendingCompactionMarker),
    [pendingSlashCommandHistoryItems],
  );

  // Keep the editor mounted during asynchronous commands and session switches.
  // Submission and queue draining have their own readiness gate above.
  const isInputVisible =
    !isSelectingInitialSession &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding ||
      streamingState === StreamingState.WaitingForConfirmation);

  // Preserve the existing stash-restoration timing while the editor stays up.
  const isInputActive =
    isInputVisible &&
    (!isProcessing || isCompacting || isPaidConfirmationPending) &&
    !isResuming;

  // Phase 1: Direct yogaNode height read replaces ResizeObserver feedback loop.
  // Timing guarantee: useAfterLayout runs immediately after the frame's Yoga
  // pass, so getComputedHeight() is fresh. (It used to be a useLayoutEffect,
  // which relied on layout running inside every commit.)
  const mainControlsNodeRef = useRef<DOMElement | null>(null);
  const [controlsHeight, setControlsHeight] = useState(0);

  const mainControlsRef = useCallback((node: DOMElement | null) => {
    mainControlsNodeRef.current = node;
  }, []);

  // Every frame in which this component committed: read controls height
  // directly from the Yoga layout result.
  // >=2 threshold eliminates ±1 oscillation without the old hysteresis hack.
  // Priority 'container': controlsHeight feeds availableTerminalHeight, which
  // feeds VirtualizedList's props, so it has to settle first.
  useAfterLayout(() => {
    const node = mainControlsNodeRef.current;
    if (!node?.yogaNode) return;
    const h = node.yogaNode.getComputedHeight();
    if (h > 0) {
      setControlsHeight((prev) => (Math.abs(h - prev) >= 2 ? h : prev));
    }
  }, AFTER_LAYOUT_PRIORITY.container);

  const stableControlsHeight = controlsHeight;

  // Compute available terminal height based on stable controls measurement
  const availableTerminalHeight = Math.max(
    0,
    terminalHeight - stableControlsHeight - 1,
  );

  config.setShellExecutionConfig({
    pager: settings.merged.tools.shell.pager,
    sanitizationConfig: config.sanitizationConfig,
  });

  const { isFocused, hasReceivedFocusEvent } = useFocus();

  // Context file names computation
  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.context.fileName;
    return fromSettings
      ? Array.isArray(fromSettings)
        ? fromSettings
        : [fromSettings]
      : [...config.getAllContextFileNames()];
  }, [settings.merged.context.fileName, config]);
  // Initial prompt handling
  // Re-compute after config.initialize() completes (isConfigInitialized)
  // so that the session agent's initialPrompt is included.
  const initialPrompt = useMemo(() => {
    if (!isConfigInitialized) return undefined;
    return config.getEffectiveQuestion();
  }, [config, isConfigInitialized]);
  const localInitialPromptSubmitted = useRef(false);
  const initialPromptSubmitted =
    props.initialPromptSubmittedRef ?? localInitialPromptSubmitted;

  useEffect(() => {
    if (isAutomaticInputBlocked) {
      initialPromptSubmitted.current = true;
      return;
    }
    if (
      initialPrompt &&
      canExecuteLocalInput &&
      !initialPromptSubmitted.current &&
      !isThemeDialogOpen &&
      !isEditorDialogOpen
    ) {
      void handleFinalSubmit(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    isAutomaticInputBlocked,
    canExecuteLocalInput,
    handleFinalSubmit,
    isThemeDialogOpen,
    isEditorDialogOpen,
    initialPromptSubmitted,
  ]);

  // 只有用户重新提交普通 Prompt 才确认当前目录；查看帮助等本地命令不能放行旧队列。
  const handleManualSubmit = useCallback(
    async (
      submittedValue: string,
      imagePastedContents?: Record<number, PastedContent>,
      preExpansionText?: string,
      slashCommandSource?: import('@qwen-code/core').SlashCommandSource,
      suppressWorkflowKeyword?: boolean,
    ) => {
      const prompt = submittedValue.trim();
      const continuesAfterWorktreeFailure =
        isAutomaticInputBlocked &&
        prompt.length > 0 &&
        !prompt.startsWith('/') &&
        !shellModeActive;
      await handleFinalSubmit(
        submittedValue,
        imagePastedContents,
        preExpansionText,
        slashCommandSource,
        suppressWorkflowKeyword,
        continuesAfterWorktreeFailure,
      );
      if (continuesAfterWorktreeFailure) resumeAutomaticInput();
    },
    [
      handleFinalSubmit,
      isAutomaticInputBlocked,
      shellModeActive,
      resumeAutomaticInput,
    ],
  );

  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showFullTodos, setShowFullTodos] = useState<boolean>(false);
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(true);

  const handleExitRepeat = useCallback(
    (count: number) => {
      if (count > 1) {
        void handleSlashCommand(
          '/quit',
          undefined,
          undefined,
          false,
          false,
          undefined,
        );
      }
    },
    [handleSlashCommand],
  );

  const { pressCount: ctrlCPressCount, handlePress: handleCtrlCPress } =
    useRepeatedKeyPress({
      windowMs: WARNING_PROMPT_DURATION_MS,
      onRepeat: handleExitRepeat,
    });

  const { pressCount: ctrlDPressCount, handlePress: handleCtrlDPress } =
    useRepeatedKeyPress({
      windowMs: WARNING_PROMPT_DURATION_MS,
      onRepeat: handleExitRepeat,
    });

  const [showEscapePrompt, setShowEscapePrompt] = useState(false);

  const {
    isFolderTrustDialogOpen,
    discoveryResults: folderDiscoveryResults,
    handleFolderTrustSelect,
  } = useFolderTrust(
    settings,
    config,
    setIsTrustedFolder,
    historyManager.addItem,
  );

  // Background plugin reconcile — runs once after trust is accepted.
  usePluginStartupChecks({
    config,
    settings,
    isTrusted: isTrustedFolder,
  });

  // Check for pending project MCP servers on mount.
  // The approval state hooks themselves are declared earlier in this file
  // (above `slashCommandActions`) so the slash command processor can open
  // the dialog from `/mcp reload` after a fresh disk read.
  useEffect(() => {
    if (!isTrustedFolder) return;
    const pending = getPendingProjectMcpServers(
      settings,
      config.storage.getProjectRoot(),
      config.getProcessMcpManager(),
    );
    if (Object.keys(pending).length > 0) {
      setPendingProjectMcpServers(pending);
      setIsMcpApprovalDialogOpen(true);
    }
  }, [isTrustedFolder, settings, config]);

  useIncludeDirsTrust(
    config,
    isTrustedFolder,
    historyManager,
    setCustomDialogGuarded,
    settings,
  );

  const handleWarning = useCallback(
    (message: string) => {
      showTransientMessage({
        message,
        type: TransientMessageType.Warning,
      });
    },
    [showTransientMessage],
  );

  const { handleSuspend } = useSuspend({
    handleWarning,
    setRawMode,
    shouldUseAlternateScreen,
  });

  useEffect(() => {
    const openDebugConsole = () => {
      setShowErrorDetails(true);
      // Expand to FullyExpanded so debug console content is not height-constrained.
      // Use the shim which handles the constrainHeight → fold level mapping.
      setConstrainHeight(false);
    };
    appEvents.on(AppEvent.OpenDebugConsole, openDebugConsole);

    return () => {
      appEvents.off(AppEvent.OpenDebugConsole, openDebugConsole);
    };
  }, [setConstrainHeight]);

  const handleEscapePromptChange = useCallback(
    (showPrompt: boolean) => {
      setShowEscapePrompt(showPrompt);
      // Cancel this session's pending ScheduleWakeup on first Esc press
      if (showPrompt && cronManager.cancelWakeup()) {
        historyManager.addItem(
          { type: MessageType.INFO, text: 'Loop wakeup cancelled' },
          Date.now(),
        );
      }
    },
    [cronManager, historyManager],
  );

  // Legacy handleGlobalKeypress removed — all functionality now handled by
  // context routing action handlers registered below.

  // ─── Keyboard Context Registration ───
  // Global, Chat, Shell, Fullscreen, Dialog contexts
  // are now managed centrally by useAppFocusContextSync() (called above).
  // Fullscreen overlay is driven by the state machine:
  useEffect(() => {
    if (!focusMachine) return;
    const hasFullscreen = !!fullScreenDialog || showErrorDetails;
    if (hasFullscreen && !focusMachine.hasOverlayOf('Fullscreen')) {
      focusMachine.pushFullscreen();
    } else if (!hasFullscreen && focusMachine.hasOverlayOf('Fullscreen')) {
      focusMachine.popFullscreen();
    }
  }, [focusMachine, fullScreenDialog, showErrorDetails]);

  // ─── Context Routing ───
  // Context-based routing dispatches key events using the ContextResolver
  // and routes to ActionHandlerRegistry handlers.
  useContextRouting({
    enabled: true,
    debug: config.getDebugMode(),
  });

  useRegisterActionHandlers(
    'Chat',
    {
      'app:toggleBackgroundShell': (_key: Key) =>
        backgroundForegroundExecutions() > 0,
    },
    activeShellId !== null || foregroundToolExecutionIds.length > 0,
  );

  // ─── Global Action Handlers ───
  // These handlers replace the former handleGlobalKeypress.
  // Each handler corresponds to a binding in defaultContextBindings['Global'].
  useRegisterActionHandlers(
    'Global',
    {
      'app:interrupt': (key: Key) => {
        // Ctrl+C: cancel any ongoing request + clear input + track press count.
        //
        // With ctrl+c moved to non-penetrating Global, this handler only fires
        // when no higher-priority context (Chat:edit:clear, HistorySearch, etc.)
        // handles Ctrl+C first. For example, when Shell is focused or when only
        // Global is active.
        //
        // When Chat IS active, Chat:edit:clear resolves first → Chat fallback
        // calls handleInput → CLEAR_INPUT path clears buffer + resets completion
        // → returns false → falls through to Global app:interrupt handler.

        if (activeShellId) {
          shellAbortControllerRef.current.abort();
          return true;
        }

        bufferRef.current?.handleInput(key);
        cancelOngoingRequest?.();
        handleCtrlCPress();
        return true;
      },
      'app:exit': (_key: Key) => {
        // Ctrl+D: exit if input is empty
        if ((bufferRef.current?.text.length ?? 0) > 0) {
          return false;
        }
        handleCtrlDPress();
        return true;
      },
      'app:suspend': (_key: Key) => {
        handleSuspend();
        return true;
      },
      'app:showErrorDetails': (_key: Key) => {
        runLogger.error(
          '[DEBUG-TRACE] app:showErrorDetails action fired (F12)',
        );
        if (fullScreenDialog && showErrorDetails) {
          setFullScreenDialog(null);
          setShowErrorDetails(false);
        } else {
          void (async () => {
            const { DebugConsoleView } = await import(
              './components/DebugConsoleView.js'
            );
            setFullScreenDialog(
              <DebugConsoleView
                onClose={() => {
                  setFullScreenDialog(null);
                  setShowErrorDetails(false);
                }}
              />,
            );
            setShowErrorDetails(true);
          })();
        }
        return true;
      },
      'app:toggleTodos': (_key: Key) => {
        setShowFullTodos((prev) => !prev);
        return true;
      },
      'app:toggleMarkdown': (_key: Key) => {
        setRenderMarkdown((prev) => !prev);
        return true;
      },
      'app:showMoreLines': (_key: Key) => {
        triggerExpandHint(null);
        setConversationScreen((screen) =>
          screen === 'transcript' ? 'prompt' : 'transcript',
        );
        return true;
      },
      'app:dumpFrame': (_key: Key) => {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `snapshot-${timestamp}.json`;
        if (dumpCurrentFrame) {
          dumpCurrentFrame(filename);
          runLogger.log(`Dumped frame to: ${filename}`);
        }
        return true;
      },
      'dev:relaunch': (_key: Key) => {
        if (process.env['DEV'] === 'true') {
          void gracefulExit(0, { exitReason: 'user_quit' });
          return true;
        }
        return false;
      },
    },
    true, // always active
  );

  // ─── Fullscreen Action Handlers ───
  // Handles fullscreen dialogs (e.g. DebugConsoleView) and error details panels.
  useRegisterActionHandlers(
    'Fullscreen',
    {
      'fullscreen:dismiss': (_key: Key) => {
        if (fullScreenDialog && showErrorDetails) {
          setFullScreenDialog(null);
          setShowErrorDetails(false);
          return true;
        }
        if (fullScreenDialog) {
          setFullScreenDialog(null);
          return true;
        }
        if (showErrorDetails) {
          setShowErrorDetails(false);
          return true;
        }
        return false;
      },
      'dialog:navigate:up': () =>
        // Navigation within fullscreen dialogs — let it bubble to Select/other primitives
        false,
      'dialog:navigate:down': () => false,
      'scroll:up': () =>
        // Scrolling within fullscreen — let it bubble to the scroll system
        false,
      'scroll:down': () => false,
      'scroll:pageUp': () => false,
      'scroll:pageDown': () => false,
    },
    !!fullScreenDialog || showErrorDetails,
  );

  // Legacy shell-focus FocusZone removed — Shell contexts + handlers below.

  // ─── Global: Shell Focus Navigation ───
  // These handlers were previously in the shell-focus FocusZone. Now they're
  // registered as Global action handlers so they work through context routing.
  // Focus transitions go through the AppFocusStateMachine.
  useRegisterActionHandlers(
    'Global',
    {
      'app:escape': (_key: Key) => {
        // Escape: cancel streaming, dismiss shortcuts help
        if (shortcutsHelpVisible) {
          setShortcutsHelpVisible(false);
          return true;
        }
        // If a foreground shell command is running, abort it.
        if (activeShellId) {
          shellAbortControllerRef.current.abort();
          return true;
        }
        if (streamingState === StreamingState.WaitingForConfirmation) {
          // Permission prompt is showing — let ESC cascade to the
          // PermissionQueue's own handler (onAbort) instead of
          // cancelling the entire session.
          return false;
        }
        // If a slash command is running (isProcessing true but not streaming),
        // trigger any registered cancellable callbacks. This must be checked
        // before StreamingState.Responding because isProcessing promotes
        // streamingState from Idle to Responding, which would otherwise
        // incorrectly route to cancelOngoingRequest instead of the command's
        // own abort handler.
        if (isProcessing) {
          paidConfirmationRef.current?.finish(false);
          triggerCancellableCallbacks?.();
          return true;
        }
        if (streamingState === StreamingState.Responding) {
          cancelOngoingRequest?.();
          return true;
        }
        return false;
      },
      'app:cyclePermissionMode': (_key: Key) => {
        // Shift+Tab cycles through all 5 permission modes
        // (dontAsk → default → acceptEdits → yolo → auto → dontAsk).
        // Plan is no longer a permission mode, so it's not part of the cycle.
        const currentMode = uiConfig.getPermissionMode();
        let nextMode = getNextPermissionMode(currentMode);

        // Skip modes that cannot be activated:
        // - yolo when disabled by policy (disableYoloMode or untrusted)
        // - any non-default mode in untrusted folders
        let skipped = 0;
        while (skipped < 5 && nextMode !== currentMode) {
          const cannotSet =
            (nextMode === 'yolo' && config.isYoloModeDisabled()) ||
            (!config.isTrustedFolder() && nextMode !== 'default');
          if (!cannotSet) break;
          nextMode = getNextPermissionMode(nextMode);
          skipped++;
        }

        if (nextMode !== currentMode) {
          try {
            uiConfig.setPermissionMode(nextMode, {
              trigger: 'shortcut',
            });
            handlePermissionModeChangeWithUiReveal?.(nextMode);
            // Transient WARNING when entering yolo / dontAsk so users notice
            // the dramatic change. Uses showTransientMessage so at most one
            // warning is visible at a time and it auto-clears after timeout.
            if (nextMode === 'yolo') {
              showTransientMessage({
                message: getBypassPermissionsWarning(),
                type: TransientMessageType.Warning,
              });
            } else if (nextMode === 'dontAsk') {
              showTransientMessage({
                message: getDontAskWarning(),
                type: TransientMessageType.Warning,
              });
            } else {
              // Leaving a dangerous mode — clear any residual warning immediately.
              showTransientMessage(null);
            }
          } catch (e) {
            // Fallback: if setPermissionMode threw (e.g., bypass disabled),
            // try the next mode in the cycle instead of getting stuck.
            const fallback = getNextPermissionMode(nextMode);
            if (fallback !== currentMode && fallback !== nextMode) {
              try {
                uiConfig.setPermissionMode(fallback, {
                  trigger: 'shortcut',
                });
                handlePermissionModeChangeWithUiReveal?.(fallback);
              } catch {
                historyManager.addItem(
                  { type: MessageType.INFO, text: (e as Error).message },
                  Date.now(),
                );
              }
            } else {
              historyManager.addItem(
                { type: MessageType.INFO, text: (e as Error).message },
                Date.now(),
              );
            }
          }
        }
        return true;
      },
      'app:toggleYolo': (_key: Key) => {
        if (
          config.isYoloModeDisabled() &&
          uiConfig.getPermissionMode() !== 'yolo'
        ) {
          historyManager.addItem(
            {
              type: MessageType.WARNING,
              text: 'You cannot enter bypass permissions mode since it is disabled in your settings.',
            },
            Date.now(),
          );
          return true;
        }
        const nextMode: PermissionMode =
          uiConfig.getPermissionMode() === 'yolo' ? 'default' : 'yolo';
        try {
          uiConfig.setPermissionMode(nextMode, { trigger: 'shortcut' });
          handlePermissionModeChangeWithUiReveal?.(nextMode);
        } catch (e) {
          historyManager.addItem(
            { type: MessageType.INFO, text: (e as Error).message },
            Date.now(),
          );
        }
        return true;
      },
    },
    true, // always active for Global
  );

  const paddedTerminalTitle = computeTerminalTitle({
    streamingState,
    isConfirming: !!commandConfirmationRequest,
    sessionTitle: sessionDisplayTitle || BRAND_CLI_NAME,
    useDynamicTitle: settings.merged.ui.dynamicWindowTitle,
  });
  const shouldRenewTerminalTitle =
    isWindowsTerminalHost() && streamingState !== StreamingState.Idle;

  useEffect(() => {
    if (settings.merged.ui.hideWindowTitle) return;

    const writeExpectedTitle = () => {
      stdout.write(`\x1b]0;${paddedTerminalTitle}\x07`);
    };

    writeExpectedTitle();
    if (!shouldRenewTerminalTitle) {
      return;
    }

    const timer = setInterval(writeExpectedTitle, 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [
    paddedTerminalTitle,
    shouldRenewTerminalTitle,
    settings.merged.ui.hideWindowTitle,
    stdout,
  ]);

  useFeedbackEvents({
    addItem: historyManager.addItem,
  });

  const nightly = props.version.includes('nightly');

  const hasPendingToolConfirmation = useMemo(
    () => isToolAwaitingConfirmation(pendingHistoryItems),
    [pendingHistoryItems],
  );

  // Everything that owns the screen apart from the peer approval prompt itself.
  // Split out because that prompt renders last of all of them and is the only one
  // raised by something other than the user, so whether it may be raised at all
  // depends on this — and folding it into `dialogsVisible` would make the answer
  // depend on itself.
  //
  // This has to cover *two* sets, and reading only one of them is what let a
  // claimed message expire behind a screen it was never drawn on: everything in
  // DialogManager's chain that is tested before the peer branch (which is last),
  // and everything DefaultAppLayout ranks above `dialog-manager` in its controls
  // ternary — `fullScreenDialog`, `customDialog`, the permission queue and the
  // pending-tool-confirmation fallback.
  const otherDialogsVisible =
    permissionQueueHasItems ||
    hasPendingToolConfirmation ||
    isFolderTrustDialogOpen ||
    isMcpApprovalDialogOpen ||
    externalImportApprovalState.isOpen ||
    adminSettingsChanged ||
    !!commandConfirmationRequest ||
    !!authConsentRequest ||
    !!customDialog ||
    !!fullScreenDialog ||
    confirmUpdateExtensionRequests.length > 0 ||
    isThemeDialogOpen ||
    isSettingsDialogOpen ||
    isAgentConfigDialogOpen ||
    isEditorDialogOpen ||
    isSessionBrowserOpen ||
    isAgentBrowserOpen ||
    isSkillBrowserOpen ||
    isSkillDetailViewOpen ||
    isConfigErrorDetailOpen ||
    isPluginBrowserOpen ||
    isMcpBrowserOpen ||
    isHookBrowserOpen ||
    isHookConfigDialogOpen ||
    isWorktreeExitDialogOpen;

  // Registers this session as the review surface for held peer messages. Only
  // the TUI does — headless and ACP keep the text notice and /peers.
  const { peerInboundApprovalRequest, handlePeerInboundApproval } =
    usePeerInboundApproval({ settings, canPrompt: !otherDialogsVisible });

  const dialogsVisible =
    otherDialogsVisible || peerInboundApprovalRequest !== null;

  const hasConfirmUpdateExtensionRequests =
    confirmUpdateExtensionRequests.length > 0;
  const hasPendingActionRequired =
    hasPendingToolConfirmation ||
    !!commandConfirmationRequest ||
    !!authConsentRequest ||
    hasConfirmUpdateExtensionRequests ||
    !!customDialog ||
    !!fullScreenDialog;

  const loadingPhrases = settings.merged.ui.loadingPhrases;
  const showStatusTips = loadingPhrases === 'tips' || loadingPhrases === 'all';
  const showStatusWit = loadingPhrases === 'witty' || loadingPhrases === 'all';

  const commandProgressMessage =
    compressionProgress?.label ??
    (isProcessing ? slashCommandProgressMessage : undefined);
  const startupProgressMessage = isStartupWaiting
    ? i18n.get('status.startup.preparing')
    : undefined;
  const activeProgressMessage =
    startupProgressMessage ?? commandProgressMessage;
  // The first-turn readiness wait is a progress phase too. Without it here,
  // StatusRow drops the phrase and shows the model progress label instead.
  const isCommandProgressActive = Boolean(activeProgressMessage?.trim());
  const showLoadingIndicator = shouldShowLoadingIndicator(
    streamingState,
    isModelTurnActive,
    isCommandProgressActive,
    hasPendingActionRequired,
  );

  let estimatedStatusLength = 0;
  if (activeHooks.length > 0 && settings.merged.hooksConfig.notifications) {
    estimatedStatusLength =
      stringWidth(getHookStatusText(activeHooks, i18n.get) ?? '') + 10;
  } else if (showLoadingIndicator) {
    const statusText =
      activeProgressMessage ?? getModelProgressLabel(thought, i18n.get);
    estimatedStatusLength = (statusText?.length ?? 0) + 25;
  } else if (hasPendingActionRequired) {
    estimatedStatusLength = 35;
  }

  const maxLength = terminalWidth - estimatedStatusLength - 5;

  // Visibility and timer lifecycle are intentionally separate. Permission
  // prompts hide the loading indicator, but the model turn remains alive and
  // its WaitingForConfirmation state must pause (not reset) elapsed time.
  const loadingTimerStreamingState =
    isModelTurnActive || isCommandProgressActive
      ? streamingState
      : StreamingState.Idle;
  const {
    elapsedTime,
    currentLoadingPhrase: defaultLoadingPhrase,
    currentTip,
    currentWittyPhrase,
  } = useLoadingIndicator({
    streamingState: loadingTimerStreamingState,
    retryStatus,
    showTips: showStatusTips,
    showWit: showStatusWit,
    customWittyPhrases: settings.merged.ui.customWittyPhrases,
    errorVerbosity: settings.merged.ui.errorVerbosity,
    maxLength,
    additionalTips: terminalSetupAdditionalTips,
    locale: uiLocale,
  });
  const currentLoadingPhrase = activeProgressMessage ?? defaultLoadingPhrase;

  // The use count is re-read each render; the elapsed-time ticks while a turn
  // runs pick up the first /btw use within a second.
  const btwTip = shouldShowBtwTip({
    showTips: showStatusTips,
    elapsedSeconds: elapsedTime,
    useCount: persistentState.get('btwUseCount'),
  })
    ? i18n.get('status.tip.btw')
    : undefined;
  const statusTip = btwTip ?? currentTip;

  const allowPlanMode =
    config.isPlanEnabled() &&
    streamingState === StreamingState.Idle &&
    !hasPendingActionRequired;

  const showPermissionModeIndicator = usePermissionModeIndicator({
    config: uiConfig,
  });

  const observedTurnEnd = useObservedTurnEnd(streamingState, hasSessionBinding);
  const programStatusBlocker = getProgramStatusBlocker({
    signInRequired: false,
    authConsentPending: !!authConsentRequest,
    pendingHistoryItems,
    permissionQueueToolNames: permissionQueueItems.map((item) => item.toolName),
    commandConfirmationPending: !!commandConfirmationRequest,
    otherApprovalPending:
      isFolderTrustDialogOpen ||
      isMcpApprovalDialogOpen ||
      externalImportApprovalState.isOpen ||
      hasConfirmUpdateExtensionRequests ||
      peerInboundApprovalRequest !== null ||
      isPaidConfirmationPending,
  });
  useProgramStatus(
    toMainProgramStatus({
      streamingState,
      queued: messageQueue.length > 0,
      blocker: programStatusBlocker,
      lastTurnEnd: hasSessionBinding
        ? observedTurnEnd
        : localProjection.lastTurnEnd,
      customSessionTitle: sessionName,
    }),
    toSubagentProgramStatuses(visibleUnifiedTasks),
  );

  useRunEventNotifications({
    notificationsEnabled,
    isFocused,
    hasReceivedFocusEvent,
    streamingState,
    hasPendingActionRequired,
    pendingHistoryItems,
    commandConfirmationRequest,
    authConsentRequest,
    hasConfirmUpdateExtensionRequests,
    config,
  });

  const isPassiveShortcutsHelpState =
    isInputActive &&
    streamingState === StreamingState.Idle &&
    !hasPendingActionRequired;

  useEffect(() => {
    if (shortcutsHelpVisible && !isPassiveShortcutsHelpState) {
      setShortcutsHelpVisible(false);
    }
  }, [
    shortcutsHelpVisible,
    isPassiveShortcutsHelpState,
    setShortcutsHelpVisible,
  ]);

  useEffect(() => {
    if (
      !canExecuteLocalInput ||
      !config.isModelSteeringEnabled() ||
      streamingState !== StreamingState.Idle ||
      isToolAwaitingConfirmation(pendingHistoryItems)
    ) {
      return;
    }

    const pendingHint = consumePendingHints();
    if (!pendingHint) {
      return;
    }

    void submitQuery([{ text: buildUserSteeringHintPrompt(pendingHint) }]);
  }, [
    config,
    historyManager,
    canExecuteLocalInput,
    streamingState,
    submitQuery,
    consumePendingHints,
    pendingHistoryItems,
    pendingHintCount,
  ]);

  // Handle pending run agent: submit query with @agent-name prefix
  useEffect(() => {
    if (
      pendingRunAgent &&
      canExecuteLocalInput &&
      streamingState === StreamingState.Idle &&
      canUseMcpTools
    ) {
      const { name, query } = pendingRunAgent;
      setPendingRunAgent(null);
      // Re-validate against the registry's live (enabled-only) set: the agent
      // may have been disabled while this run was queued (e.g. project agent
      // on trust revocation, plugin agent on hot-reload).
      if (!config.getAgentRegistry()?.getDefinition(name)) {
        handleWarning(`Agent "${name}" is disabled or unavailable.`);
        return;
      }
      const agentPrompt = query.trim() ? `@${name} ${query}` : `@${name}`;
      void handleFinalSubmit(agentPrompt);
    }
  }, [
    pendingRunAgent,
    canExecuteLocalInput,
    streamingState,
    canUseMcpTools,
    handleFinalSubmit,
    config,
    handleWarning,
  ]);

  const allToolCalls = useMemo(
    () => getAllToolCalls(pendingHistoryItems),
    [pendingHistoryItems],
  );

  // Kept out of the uiState memo so a new pending array does not change
  // uiState's identity; only the derived boolean is published.
  const hintMode = useMemo(
    () =>
      config.isModelSteeringEnabled() && isToolExecuting(pendingHistoryItems),
    [config, pendingHistoryItems],
  );

  const pendingHistoryValue = useMemo(
    () => ({ pendingHistoryItems, pendingGeminiHistoryItems, thought }),
    [pendingHistoryItems, pendingGeminiHistoryItems, thought],
  );

  const { memoryMdFileCount, memoryWarnings } = useMemoryStatus(config);
  useAgentsMdSizeWarning(config, historyManager.addItem);
  const startupWarnings = useMemo(
    () => [...(props.startupWarnings ?? []), ...memoryWarnings],
    [memoryWarnings, props.startupWarnings],
  );
  useStartupWarningHistory(startupWarnings, historyManager.addItem);

  const uiState: UIState = useMemo(
    () => ({
      history: historyManager.history,
      historyManager,
      mcpAuthNotice,
      isThemeDialogOpen,

      themeError,
      isConfigInitialized,
      sessionGateVisible: sessionGateState.visible,
      editorError,
      isEditorDialogOpen,
      corgiMode,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      isSessionBrowserOpen,
      sessionBrowserInitialSearchQuery:
        sessionBrowserOptions.initialSearchQuery,
      isAgentConfigDialogOpen,
      isAgentBrowserOpen,
      agentBrowserActiveTab,
      isMcpBrowserOpen,
      selectedAgentName,
      selectedAgentDefinition,
      isHookBrowserOpen,
      isHookConfigDialogOpen,
      selectedHookEntry,
      isSkillBrowserOpen,
      isSkillDetailViewOpen,
      selectedSkillInfo,
      isConfigErrorDetailOpen,
      selectedConfigError,
      configErrorLabel,
      isPluginBrowserOpen,
      pluginBrowserArgs,
      isWorktreeExitDialogOpen,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      commandConfirmationRequest,
      authConsentRequest,
      confirmUpdateExtensionRequests,
      memoryMdFileCount,
      streamingState,
      isModelTurnActive,
      isCommandProgressActive,
      compressionProgress,
      activeModelQueue: displayedActiveModelQueue,
      modelNextActionSuggestions: visibleModelNextActionSuggestions,
      isInputActive,
      isInputVisible,
      isResuming,
      sessionName,
      isFolderTrustDialogOpen: isFolderTrustDialogOpen ?? false,
      folderDiscoveryResults,
      isMcpApprovalDialogOpen,
      pendingProjectMcpServers,
      isExternalImportApprovalOpen: externalImportApprovalState.isOpen,
      pendingExternalImports: externalImportApprovalState.pendingImports,
      peerInboundApprovalRequest,
      isTrustedFolder,
      constrainHeight:
        conversationScreen === 'transcript' ? false : constrainHeight,
      showErrorDetails,
      showFullTodos,
      renderMarkdown,
      ctrlCPressedOnce: ctrlCPressCount >= 1,
      ctrlDPressedOnce: ctrlDPressCount >= 1,
      shortcutsHelpVisible,
      cleanUiDetailsVisible,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      currentTip: statusTip,
      currentWittyPhrase,
      conversationKey,
      conversationScreen,
      activeHooks,
      messageQueue,
      queueErrorMessage,
      showPermissionModeIndicator,
      allowPlanMode,
      hasSessionBinding,
      currentModel,
      currentReasoningEffort,
      currentContextWindow,
      contextFileNames,
      errorCount,
      availableTerminalHeight,
      stableControlsHeight,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      hasPendingToolConfirmation,
      nightly,
      branchName,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      rootUiRef,
      updateInfo,
      extensionsUpdateState,
      activeShellId: activeShellId ?? undefined,
      showDebugProfiler,
      customDialog,
      fullScreenDialog,
      transientMessage,
      terminalBackgroundColor: config.getTerminalBackground(),
      settingsNonce,
      unifiedTasks: visibleUnifiedTasks,
      workflowHistoryTasks,
      unifiedRunningCount: visibleBackgroundRunningCount,
      viewedAgentTaskId,
      sessionRailSelectionMode,
      viewedWorkflowTaskId,
      adminSettingsChanged,
      showIsExpandableHint,
      hintMode,
      hintBuffer: '',
    }),
    [
      isThemeDialogOpen,
      mcpAuthNotice,
      themeError,
      isConfigInitialized,
      sessionGateState.visible,
      editorError,
      isEditorDialogOpen,
      corgiMode,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      isSessionBrowserOpen,
      sessionBrowserOptions.initialSearchQuery,
      isAgentConfigDialogOpen,
      isAgentBrowserOpen,
      agentBrowserActiveTab,
      isMcpBrowserOpen,
      selectedAgentName,
      selectedAgentDefinition,
      isHookBrowserOpen,
      isHookConfigDialogOpen,
      selectedHookEntry,
      isSkillBrowserOpen,
      isSkillDetailViewOpen,
      selectedSkillInfo,
      isConfigErrorDetailOpen,
      selectedConfigError,
      configErrorLabel,
      isPluginBrowserOpen,
      pluginBrowserArgs,
      isWorktreeExitDialogOpen,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      commandConfirmationRequest,
      authConsentRequest,
      confirmUpdateExtensionRequests,
      memoryMdFileCount,
      streamingState,
      isModelTurnActive,
      isCommandProgressActive,
      compressionProgress,
      displayedActiveModelQueue,
      visibleModelNextActionSuggestions,
      isInputActive,
      isInputVisible,
      isResuming,
      sessionName,
      isFolderTrustDialogOpen,
      folderDiscoveryResults,
      isMcpApprovalDialogOpen,
      pendingProjectMcpServers,
      externalImportApprovalState,
      isTrustedFolder,
      constrainHeight,
      conversationScreen,
      showErrorDetails,
      showFullTodos,
      renderMarkdown,
      ctrlCPressCount,
      ctrlDPressCount,
      shortcutsHelpVisible,
      cleanUiDetailsVisible,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      statusTip,
      currentWittyPhrase,
      conversationKey,
      activeHooks,
      messageQueue,
      queueErrorMessage,
      showPermissionModeIndicator,
      allowPlanMode,
      hasSessionBinding,
      currentReasoningEffort,
      currentContextWindow,
      contextFileNames,
      errorCount,
      availableTerminalHeight,
      stableControlsHeight,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      hasPendingToolConfirmation,
      hintMode,
      nightly,
      branchName,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      rootUiRef,
      updateInfo,
      currentModel,
      extensionsUpdateState,
      activeShellId,
      historyManager,
      showDebugProfiler,
      customDialog,
      fullScreenDialog,
      transientMessage,
      config,
      settingsNonce,
      visibleUnifiedTasks,
      workflowHistoryTasks,
      visibleBackgroundRunningCount,
      viewedAgentTaskId,
      sessionRailSelectionMode,
      viewedWorkflowTaskId,
      adminSettingsChanged,
      showIsExpandableHint,
      peerInboundApprovalRequest,
    ],
  );

  const isToolExpandedForCurrentScreen = useCallback(
    (callId: string) =>
      conversationScreen === 'transcript' || isExpanded(callId),
    [conversationScreen, isExpanded],
  );

  const handleMcpApproval = useCallback(
    (results: McpApprovalResult[]) => {
      let persistenceFailed = false;
      for (const result of results) {
        let persisted = true;
        switch (result.choice) {
          case McpApprovalChoice.APPROVE_ALL:
            persisted = approveAllProjectMcpServers(settings);
            break;
          case McpApprovalChoice.APPROVE:
            persisted = approveProjectMcpServer(result.serverName, settings);
            break;
          case McpApprovalChoice.REJECT:
            persisted = rejectProjectMcpServer(result.serverName, settings);
            break;
          default:
            break;
        }
        if (!persisted) {
          // The choice still applies to this session, but on the next start the
          // dialog will ask again. Staying silent here made that look like the
          // approval was ignored.
          persistenceFailed = true;
          runLogger.warn(
            `[mcp] persisting project MCP approval failed server=${result.serverName} choice=${result.choice} user_settings=${settings.user.path}`,
          );
          break;
        }
      }
      setIsMcpApprovalDialogOpen(false);
      setPendingProjectMcpServers({});
      if (persistenceFailed) {
        coreEvents.emitFeedback(
          'error',
          'MCP server approval could not be saved to your user settings, so it will be requested again on the next start.',
        );
      }

      // Connect newly approved servers, and merge them into Config disk
      // bucket so future `mcpClientManager.restart()` calls (e.g. another
      // /mcp reload) continue to see them as live members of the
      // settings-backed set.
      const mcpClientManager = config.getMcpClientManager();
      const existingMcp = { ...(config.getDiskMcpServers() ?? {}) };
      let mcpServersChanged = false;
      for (const result of results) {
        if (
          result.choice !== McpApprovalChoice.APPROVE &&
          result.choice !== McpApprovalChoice.APPROVE_ALL
        ) {
          continue;
        }
        const serverConfig = pendingProjectMcpServers[result.serverName];
        if (!serverConfig) continue;
        if (!(result.serverName in existingMcp)) {
          existingMcp[result.serverName] = serverConfig;
          mcpServersChanged = true;
        }
        mcpClientManager
          ?.maybeDiscoverMcpServer(result.serverName, serverConfig)
          .catch((err: unknown) => {
            runLogger.log(
              'warn',
              `Failed to connect MCP server ${result.serverName}: ${getErrorMessage(err)}`,
            );
          });
      }
      if (mcpServersChanged) {
        config.setDiskMcpServers(existingMcp);
      }
    },
    [config, pendingProjectMcpServers, settings],
  );

  const uiActions: UIActions = useMemo(
    () => ({
      handleThemeSelect,
      closeThemeDialog,
      handleThemeHighlight,
      onSessionGateStateChange: setSessionGateState,
      handleEditorSelect,
      exitEditorDialog,
      closeSettingsDialog,
      openAgentConfigDialog,
      closeAgentConfigDialog,
      openAgentBrowser,
      closeAgentBrowser,
      setAgentBrowserActiveTab,
      openMcpBrowser,
      closeMcpBrowser,
      openHookBrowser,
      closeHookBrowser,
      openHookConfigDialog,
      closeHookConfigDialog,
      openSkillBrowser,
      closeSkillBrowser,
      openSkillDetailView,
      closeSkillDetailView,
      openConfigErrorDetail,
      closeConfigErrorDetail,
      openPluginBrowser,
      closePluginBrowser,
      openWorktreeExitDialog,
      closeWorktreeExitDialog,
      setShellModeActive,
      handleFolderTrustSelect,
      handleMcpApproval,
      handleExternalImportApproval,
      handlePeerInboundApproval,
      setConstrainHeight,
      onEscapePromptChange: handleEscapePromptChange,
      requestRender,
      handleFinalSubmit: handleManualSubmit,
      handleClearScreen,
      openSessionBrowser,
      closeSessionBrowser,
      openRewindDialog,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      addMessage,
      popAllMessages,
      sendQueuedNow,
      setShortcutsHelpVisible,
      setCleanUiDetailsVisible,
      toggleCleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
      handleWarning,
      openBackgroundTaskList,
      viewAgentSession: (taskId: string) => {
        if (!agentSessionsEnabled) {
          return;
        }
        // Release retain on previously viewed task
        if (viewedAgentTaskId && viewedAgentTaskId !== taskId) {
          releaseTaskView(viewedAgentTaskId);
        }
        if (viewedWorkflowTaskId) {
          releaseTaskView(viewedWorkflowTaskId);
          setViewedWorkflowTaskId(undefined);
        }
        setSessionRailSelectionMode(undefined);
        taskRegistry.update(taskId, { retainReason: 'agent-session-view' });
        setViewedAgentTaskId(taskId);
      },
      viewWorkflowSessions,
      viewWorkflowSession: (taskId: string) => {
        if (viewedAgentTaskId) {
          releaseTaskView(viewedAgentTaskId);
          setViewedAgentTaskId(undefined);
        }
        if (viewedWorkflowTaskId && viewedWorkflowTaskId !== taskId) {
          releaseTaskView(viewedWorkflowTaskId);
        }
        taskRegistry.update(taskId, { retainReason: 'task-detail-view' });
        setSessionRailSelectionMode(undefined);
        setViewedWorkflowTaskId(taskId);
      },
      viewMainSession,
      onHintInput: () => {},
      onHintBackspace: () => {},
      onHintClear: () => {},
      onHintSubmit: () => {},
      handleRestart: async () => {
        process.stderr.write(`\n${getUiText('settings.restartApplyResult')}\n`);
        await gracefulExit(0, { exitReason: 'user_quit' });
      },
      getPreferredEditor,
      runAgent: (name: string, query: string) => {
        if (!config.getAgentRegistry()?.getDefinition(name)) {
          handleWarning(`Agent "${name}" is disabled or unavailable.`);
          return;
        }
        // Close all agent panels
        closeAgentConfigDialog();
        closeAgentBrowser();
        // Set pending run agent to trigger execution in main session
        setPendingRunAgent({ name, query });
      },
      setInputText: (text: string) => {
        closeAgentBrowser();
        closeAgentConfigDialog();
        closeSkillBrowser();
        closeSkillDetailView();
        closePluginBrowser();
        bufferRef.current?.setText(text, 'end');
      },
    }),
    [
      handleThemeSelect,
      closeThemeDialog,
      handleThemeHighlight,
      handleEditorSelect,
      exitEditorDialog,
      closeSettingsDialog,
      openAgentConfigDialog,
      closeAgentConfigDialog,
      openAgentBrowser,
      closeAgentBrowser,
      setAgentBrowserActiveTab,
      openMcpBrowser,
      closeMcpBrowser,
      openHookBrowser,
      closeHookBrowser,
      openHookConfigDialog,
      closeHookConfigDialog,
      openSkillBrowser,
      closeSkillBrowser,
      openSkillDetailView,
      closeSkillDetailView,
      openConfigErrorDetail,
      closeConfigErrorDetail,
      openPluginBrowser,
      closePluginBrowser,
      openWorktreeExitDialog,
      closeWorktreeExitDialog,
      setShellModeActive,
      handleFolderTrustSelect,
      handleMcpApproval,
      handleExternalImportApproval,
      handlePeerInboundApproval,
      setConstrainHeight,
      handleEscapePromptChange,
      requestRender,
      handleManualSubmit,
      handleClearScreen,
      openSessionBrowser,
      closeSessionBrowser,
      openRewindDialog,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      addMessage,
      popAllMessages,
      sendQueuedNow,
      setShortcutsHelpVisible,
      setCleanUiDetailsVisible,
      toggleCleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
      handleWarning,
      openBackgroundTaskList,
      agentSessionsEnabled,
      setViewedAgentTaskId,
      viewedAgentTaskId,
      setViewedWorkflowTaskId,
      viewedWorkflowTaskId,
      taskRegistry,
      releaseTaskView,
      viewWorkflowSessions,
      viewMainSession,
      getPreferredEditor,
      config,
      getUiText,
    ],
  );

  const fatalStartupError =
    startupInitializationError &&
    (!props.onInitialResumeComplete || initialSessionStartSettledRef.current)
      ? startupInitializationError
      : null;
  const policyStartupError =
    fatalStartupError instanceof PermissionModeUnavailableError
      ? fatalStartupError
      : null;
  useEffect(() => {
    if (!policyStartupError) return;
    // Let Ink paint the error before exit cleanup unmounts the UI.
    const timer = setTimeout(() => {
      sessionLogger.setExitContext({
        reason: 'config_error',
        exit_code: 1,
        message: policyStartupError.message,
        source: 'ui.appContainer.startup',
      });
      void gracefulExit(1, { exitReason: 'error' });
    }, 100);
    return () => clearTimeout(timer);
  }, [policyStartupError]);

  if (fatalStartupError) {
    if (policyStartupError) return <Text>{policyStartupError.message}</Text>;
    throw fatalStartupError;
  }

  return (
    <SessionGateContext.Provider value={SessionGate}>
      <UIStateContext.Provider value={uiState}>
        <PendingHistoryContext.Provider value={pendingHistoryValue}>
          <InputStateProvider
            userMessages={inputHistory}
            shellModeActive={shellModeActive}
            showEscapePrompt={showEscapePrompt}
            inputWidth={inputWidth}
            suggestionsWidth={suggestionsWidth}
            stdin={stdin}
            setRawMode={setRawMode}
            getPreferredEditor={getPreferredEditor}
            bufferRef={bufferRef}
          >
            <UIActionsContext.Provider value={uiActions}>
              <TaskRegistryProvider registry={taskRegistry}>
                <ConfigContext.Provider value={uiConfig}>
                  <AppContext.Provider
                    value={{
                      version: props.version,
                    }}
                  >
                    <ToolActionsProvider
                      toolCalls={allToolCalls}
                      isExpanded={isToolExpandedForCurrentScreen}
                      toggleExpansion={toggleExpansion}
                      toggleAllExpansion={toggleAllExpansion}
                      permissionQueueLookup={permissionQueueLookup}
                    >
                      <MouseProvider mouseEventsEnabled={isAlternateBuffer}>
                        <ScrollProvider>
                          <FullScreenPanelProvider
                            onDialogChange={setFullScreenDialog}
                          >
                            <App key={`app-${forceRerenderKey}`} />
                          </FullScreenPanelProvider>
                        </ScrollProvider>
                      </MouseProvider>
                    </ToolActionsProvider>
                  </AppContext.Provider>
                </ConfigContext.Provider>
              </TaskRegistryProvider>
            </UIActionsContext.Provider>
          </InputStateProvider>
        </PendingHistoryContext.Provider>
      </UIStateContext.Provider>
    </SessionGateContext.Provider>
  );
};

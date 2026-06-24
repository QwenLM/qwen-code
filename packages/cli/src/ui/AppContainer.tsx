/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { type DOMElement, measureElement } from 'ink';
import { App } from './App.js';
import { AppContext } from './contexts/AppContext.js';
import { UIStateContext, type UIState } from './contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import { ConfigContext } from './contexts/ConfigContext.js';
import {
  type HistoryItem,
  type HistoryItemUser,
  ToolCallStatus,
  type HistoryItemWithoutId,
} from './types.js';
import type { RestoreOption } from './components/RewindSelector.js';
import { MessageType, StreamingState } from './types.js';
import {
  type EditorType,
  type Config,
  type IdeInfo,
  type IdeContext,
  IdeClient,
  ideContextStore,
  createDebugLogger,
  getErrorMessage,
  getAllGeminiMdFilenames,
  ShellExecutionService,
  Storage,
  createInstructionsLoadedCallback,
  SessionEndReason,
  generatePromptSuggestion,
  logPromptSuggestion,
  PromptSuggestionEvent,
  logSpeculation,
  SpeculationEvent,
  logWorkflowKeyword,
  WorkflowKeywordEvent,
  startSpeculation,
  acceptSpeculation,
  abortSpeculation,
  type SpeculationState,
  IDLE_SPECULATION,
  ApprovalMode,
  ConditionalRulesRegistry,
  MCPDiscoveryState,
  ToolConfirmationOutcome,
  type WaitingToolCall,
  ToolNames,
  clearWorktreeSession,
  restoreWorktreeContext,
  GitWorktreeService,
  readWorktreeSessionMarker,
  isSessionRuntimeActive,
} from '@qwen-code/qwen-code-core';
import {
  applyCollapsePolicyAndSummary,
  buildResumedHistoryItems,
  expandCollapsedHistory,
} from './utils/resumeHistoryUtils.js';
import { loadLowlight } from './utils/lowlightLoader.js';
import {
  getStickyTodos,
  getStickyTodoMaxVisibleItems,
  getStickyTodosLayoutKey,
  getStickyTodosRenderKey,
} from './utils/todoSnapshot.js';
import type { TodoItem } from './components/TodoDisplay.js';
import { loadHierarchicalGeminiMemory } from '../config/config.js';
import {
  profileCheckpoint,
  finalizeStartupProfile,
} from '../utils/startupProfiler.js';
import { appEvents } from '../utils/events.js';
import process from 'node:process';

/**
 * Window in which mcp-client-update events are coalesced before the cli calls
 * `setTools()`. Matches Claude Code's `MCP_BATCH_FLUSH_MS` (16 ≈ one 60Hz
 * frame). Smaller windows would refresh the model tool list more often
 * without user benefit; larger windows would let multiple servers settle
 * before the model sees them. 16ms is the sweet spot validated by Claude's
 * production deployment (see design.md § 8.3 + § 3.2 Round 2).
 */
const MCP_BATCH_FLUSH_MS = 16;

/**
 * Maximum time we keep the startup profile open waiting for MCP discovery to
 * settle. Slightly longer than the default 30s per-server discovery timeout
 * so a server that times out can still log its `outcome: failed` event into
 * the profile. After this cap the profile file is written regardless.
 */
const STARTUP_PROFILE_FINALIZE_CAP_MS = 35_000;
import { useHistory } from './hooks/useHistoryManager.js';
import { useMemoryMonitor } from './hooks/useMemoryMonitor.js';
import { useResizeSettleRepaint } from './hooks/useResizeSettleRepaint.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useFeedbackDialog } from './hooks/useFeedbackDialog.js';
import { useAuthCommand } from './auth/useAuth.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { usePreferredEditor } from './hooks/usePreferredEditor.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useModelCommand } from './hooks/useModelCommand.js';
import { useArenaCommand } from './hooks/useArenaCommand.js';
import { useApprovalModeCommand } from './hooks/useApprovalModeCommand.js';
import { useBranchCommand } from './hooks/useBranchCommand.js';
import { useResumeCommand } from './hooks/useResumeCommand.js';
import { useDeleteCommand } from './hooks/useDeleteCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useDoublePress } from './hooks/useDoublePress.js';
import {
  computeApiTruncationIndex,
  isRealUserTurn,
} from './utils/historyMapping.js';
import { restoreGoalFromHistory } from './utils/restoreGoal.js';
import {
  useVimModeState,
  useVimModeActions,
} from './contexts/VimModeContext.js';
import { CompactModeProvider } from './contexts/CompactModeContext.js';
import { ThoughtExpandedProvider } from './contexts/ThoughtExpandedContext.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { calculatePromptWidths } from './components/InputPrompt.js';
import { useStdin, useStdout } from 'ink';
import ansiEscapes from 'ansi-escapes';
import * as fs from 'node:fs';
import { basename } from 'node:path';
import {
  formatSessionWindowTitle,
  writeTerminalTitle,
} from '../utils/windowTitle.js';
import { clearScreen } from '../utils/stdioHelpers.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import {
  useGeminiStream,
  type CancelSubmitInfo,
} from './hooks/useGeminiStream.js';
import type { TrackedExecutingToolCall } from './hooks/useReactToolScheduler.js';
import { useVim } from './hooks/vim.js';
import { isBtwCommand, isSlashCommand } from './utils/commandUtils.js';
import {
  detectWorkflowKeyword,
  buildWorkflowSteeringNotice,
} from './utils/workflow-keyword.js';
import { type LoadedSettings, SettingScope } from '../config/settings.js';
import { type InitializationResult } from '../core/initializer.js';
import { useFocus } from './hooks/useFocus.js';
import { useAwaySummary } from './hooks/useAwaySummary.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useKeypress, type Key } from './hooks/useKeypress.js';
import { keyMatchers, Command } from './keyMatchers.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useTerminalProgress } from './hooks/useTerminalProgress.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { useMcpApproval } from './hooks/useMcpApproval.js';
import { useIdeTrustListener } from './hooks/useIdeTrustListener.js';
import { type IdeIntegrationNudgeResult } from './IdeIntegrationNudge.js';
import { type CommandMigrationNudgeResult } from './CommandFormatMigrationNudge.js';
import { useCommandMigration } from './hooks/useCommandMigration.js';
import { migrateTomlCommands } from '../services/command-migration-tool.js';
import { sendNotification } from '../services/notificationService.js';
import { type UpdateObject } from './utils/updateCheck.js';
import { setUpdateHandler } from '../utils/handleAutoUpdate.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import { useMessageQueue } from './hooks/useMessageQueue.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useWorktreeSession } from './hooks/useWorktreeSession.js';
import type { StatusLinePresetConfig } from './statusLinePresets.js';
import {
  useExtensionUpdates,
  useConfirmUpdateRequests,
  useSettingInputRequests,
  usePluginChoiceRequests,
} from './hooks/useExtensionUpdates.js';
import { useProviderUpdates } from './hooks/useProviderUpdates.js';
import { ShellFocusContext } from './contexts/ShellFocusContext.js';
import {
  RenderModeProvider,
  type RenderMode,
} from './contexts/RenderModeContext.js';
import { TerminalOutputProvider } from './contexts/TerminalOutputContext.js';
import {
  ThinkingViewerProvider,
  type ThinkingViewerData,
} from './contexts/ThinkingViewerContext.js';
import { ThinkingViewer } from './components/ThinkingViewer.js';
import { useAgentViewState } from './contexts/AgentViewContext.js';
import {
  useBackgroundTaskViewState,
  useBackgroundTaskViewActions,
} from './contexts/BackgroundTaskViewContext.js';
import { t } from '../i18n/index.js';
import { useWelcomeBack } from './hooks/useWelcomeBack.js';
import { useDialogClose } from './hooks/useDialogClose.js';
import { useInitializationAuthError } from './hooks/useInitializationAuthError.js';
import { useSubagentCreateDialog } from './hooks/useSubagentCreateDialog.js';
import { useAgentsManagerDialog } from './hooks/useAgentsManagerDialog.js';
import { useSkillsManagerDialog } from './hooks/useSkillsManagerDialog.js';
import { useExtensionsManagerDialog } from './hooks/useExtensionsManagerDialog.js';
import { useMcpDialog } from './hooks/useMcpDialog.js';
import { useHooksDialog } from './hooks/useHooksDialog.js';
import { useStatsDialog } from './hooks/useStatsDialog.js';
import { useMemoryDialog } from './hooks/useMemoryDialog.js';
import { useAttentionNotifications } from './hooks/useAttentionNotifications.js';
import { buildTerminalNotification } from './hooks/useTerminalNotification.js';
import { useContextualTips } from './hooks/useContextualTips.js';
import { getTipHistory } from '../services/tips/index.js';
import { useRemoteInput } from '../remoteInput/RemoteInputContext.js';
import { useDualOutput } from '../dualOutput/DualOutputContext.js';
import {
  requestConsentInteractive,
  requestConsentOrFail,
} from '../commands/extensions/consent.js';
import { compactToggleHasVisualEffect } from './utils/mergeCompactToolGroups.js';
import {
  findLastUserItemIndex,
  isSyntheticHistoryItem,
  itemsAfterAreOnlySynthetic,
} from './utils/historyUtils.js';
import { MAIN_CONTENT_HEIGHT_RESERVATION } from './utils/layoutUtils.js';

const CTRL_EXIT_PROMPT_DURATION_MS = 1000;
const debugLogger = createDebugLogger('APP_CONTAINER');

export function isRenderModeToggleKey(key: Key): boolean {
  return (
    keyMatchers[Command.TOGGLE_RENDER_MODE](key) ||
    (key.name === 'm' && key.meta && !key.ctrl && !key.paste)
  );
}

export function getNextRenderMode(current: RenderMode): RenderMode {
  return current === 'render' ? 'raw' : 'render';
}

export function handleRenderModeToggleKey(
  key: Key,
  setRenderMode: Dispatch<SetStateAction<RenderMode>>,
): boolean {
  if (!isRenderModeToggleKey(key)) {
    return false;
  }

  setRenderMode(getNextRenderMode);
  return true;
}

function isToolExecuting(pendingHistoryItems: HistoryItemWithoutId[]) {
  return pendingHistoryItems.some((item) => {
    if (item && item.type === 'tool_group') {
      return item.tools.some(
        (tool) => ToolCallStatus.Executing === tool.status,
      );
    }
    return false;
  });
}

function getResponseCandidateTokens(
  pendingGeminiHistoryItems: HistoryItemWithoutId[],
): number {
  let tokens = 0;

  for (const item of pendingGeminiHistoryItems) {
    if (item.type !== 'tool_group') {
      continue;
    }

    for (const tool of item.tools) {
      const display = tool.resultDisplay;
      if (
        typeof display === 'object' &&
        display !== null &&
        'type' in display &&
        display.type === 'task_execution' &&
        'tokenCount' in display &&
        typeof display.tokenCount === 'number'
      ) {
        tokens += display.tokenCount;
      }
    }
  }

  return tokens;
}

function useStableStickyTodos(todos: TodoItem[] | null): TodoItem[] | null {
  const renderKey = getStickyTodosRenderKey(todos);
  const stableTodosRef = useRef<{
    renderKey: string;
    todos: TodoItem[] | null;
  } | null>(null);

  if (stableTodosRef.current?.renderKey !== renderKey) {
    stableTodosRef.current = { renderKey, todos };
  }

  return stableTodosRef.current.todos;
}

// Exported for tests. Given a newest-first list of messages, return a list
// with duplicates removed, keeping the first (newest) occurrence of each.
export function dedupeNewestFirst(messages: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const msg of messages) {
    if (!seen.has(msg)) {
      seen.add(msg);
      result.push(msg);
    }
  }
  return result;
}

export function mergeStartupWarnings(
  currentWarnings: readonly string[],
  nextWarnings: readonly string[],
): string[] {
  return [...new Set([...currentWarnings, ...nextWarnings])];
}

interface AppContainerProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  initializationResult: InitializationResult;
}

/**
 * The fraction of the terminal width to allocate to the shell.
 * This provides horizontal padding.
 */
const SHELL_WIDTH_FRACTION = 0.89;

/**
 * The number of lines to subtract from the available terminal height
 * for the shell. This provides vertical padding and space for other UI elements.
 */
const SHELL_HEIGHT_PADDING = 10;

export const AppContainer = (props: AppContainerProps) => {
  const { settings, config, initializationResult } = props;
  const historyManager = useHistory();
  // `useHistory()` returns a fresh memoized object whenever `history` changes,
  // so depending on `historyManager` directly inside event-handler callbacks
  // would rebuild them on every message. Mirror history into a ref so
  // handlers can read the latest snapshot at call time without reactive deps.
  const historyRef = useRef(historyManager.history);
  historyRef.current = historyManager.history;
  useMemoryMonitor(historyManager);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const [themeError, setThemeError] = useState<string | null>(
    initializationResult.themeError,
  );
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [embeddedShellFocused, setEmbeddedShellFocused] = useState(false);

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(
    initializationResult.geminiMdFileCount,
  );
  const [shellModeActive, setShellModeActive] = useState(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [historyRemountKey, setHistoryRemountKey] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const [isTrustedFolder, setIsTrustedFolder] = useState<boolean | undefined>(
    config.isTrustedFolder(),
  );

  const extensionManager = config.getExtensionManager();

  const { addConfirmUpdateExtensionRequest, confirmUpdateExtensionRequests } =
    useConfirmUpdateRequests();

  const { addSettingInputRequest, settingInputRequests } =
    useSettingInputRequests();

  const { addPluginChoiceRequest, pluginChoiceRequests } =
    usePluginChoiceRequests();

  extensionManager.setRequestConsent(
    requestConsentOrFail.bind(null, (description) =>
      requestConsentInteractive(description, addConfirmUpdateExtensionRequest),
    ),
  );

  extensionManager.setRequestChoicePlugin(
    (marketplace) =>
      new Promise<string>((resolve, reject) => {
        addPluginChoiceRequest({
          marketplaceName: marketplace.name,
          plugins: marketplace.plugins.map((p) => ({
            name: p.name,
            description: p.description,
          })),
          onSelect: (pluginName) => {
            resolve(pluginName);
          },
          onCancel: () => {
            reject(new Error('Plugin selection cancelled'));
          },
        });
      }),
  );

  extensionManager.setRequestSetting(
    (setting) =>
      new Promise<string>((resolve, reject) => {
        addSettingInputRequest({
          settingName: setting.name,
          settingDescription: setting.description,
          sensitive: setting.sensitive ?? false,
          onSubmit: (value) => {
            resolve(value);
          },
          onCancel: () => {
            reject(new Error('Setting input cancelled'));
          },
        });
      }),
  );

  const {
    extensionsUpdateState,
    extensionsUpdateStateInternal,
    dispatchExtensionStateUpdate,
  } = useExtensionUpdates(
    extensionManager,
    historyManager.addItem,
    config.getWorkingDir(),
  );

  const { providerUpdateRequest, dismissProviderUpdate } = useProviderUpdates(
    settings,
    config,
    historyManager.addItem,
  );

  const [isTrustDialogOpen, setTrustDialogOpen] = useState(false);
  const openTrustDialog = useCallback(() => setTrustDialogOpen(true), []);
  const closeTrustDialog = useCallback(() => setTrustDialogOpen(false), []);

  const [isPermissionsDialogOpen, setPermissionsDialogOpen] = useState(false);
  const openPermissionsDialog = useCallback(
    () => setPermissionsDialogOpen(true),
    [],
  );
  const closePermissionsDialog = useCallback(
    () => setPermissionsDialogOpen(false),
    [],
  );

  const [currentModel, setCurrentModel] = useState(() => config.getModel());

  const [isConfigInitialized, setConfigInitialized] = useState(false);

  const [userMessages, setUserMessages] = useState<string[]>([]);

  // Thinking viewer overlay state
  const [thinkingViewerData, setThinkingViewerData] =
    useState<ThinkingViewerData | null>(null);
  const openThinkingViewer = useCallback((data: ThinkingViewerData) => {
    setThinkingViewerData(data);
  }, []);
  const closeThinkingViewer = useCallback(() => {
    setThinkingViewerData(null);
  }, []);

  // Alt+T inline expansion toggle for thinking blocks
  const [thoughtExpanded, setThoughtExpanded] = useState(false);

  // Terminal and layout hooks
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();

  // Raw write function for terminal escape sequences.
  // Uses process.stdout directly instead of Ink's useStdout() because
  // standard Ink v6.2.3 proxies stdout writes through its rendering
  // pipeline, which can corrupt binary escape sequences (OSC, DCS).
  const writeRaw = useCallback((data: string) => {
    process.stdout.write(data);
  }, []);

  // Terminal notification helpers (constructed directly, not via context)
  const terminal = useMemo(
    () => buildTerminalNotification(writeRaw),
    [writeRaw],
  );

  // Additional hooks moved from App.tsx
  const {
    stats: sessionStats,
    startNewSession,
    seedPromptCount,
  } = useSessionStats();
  const logger = useLogger(config.storage, sessionStats.sessionId);
  const branchName = useGitBranchName(config.getTargetDir());
  const worktreeSession = useWorktreeSession(config);
  const [showWorktreeExitDialog, setShowWorktreeExitDialog] = useState(false);
  // P7-trigger: true while the current turn was steered toward the Workflow
  // tool by the `workflow` keyword (drives the Footer indicator). Set in
  // `handleFinalSubmit`, cleared when the turn returns to idle (effect below).
  const [workflowKeywordActive, setWorkflowKeywordActive] = useState(false);
  /**
   * One-shot worktree restore reminder for the TUI path. Set during
   * `--resume` when the persisted sidecar names a live worktree, then
   * consumed and cleared by `handleFinalSubmit` on the user's first
   * prompt — same shape as ACP `Session.pendingWorktreeNotice` and
   * headless's `<system-reminder>` prefix. Without this, the resumed
   * model would see an INFO history item in the TUI but never receive
   * the reminder in the next API request, leaving it free to edit the
   * parent checkout. (PR #4174 review #3259975249.)
   */
  const pendingWorktreeNoticeRef = useRef<string | null>(null);
  const activeWorktree = useMemo(
    () =>
      worktreeSession
        ? {
            slug: worktreeSession.slug,
            branch: worktreeSession.worktreeBranch,
            path: worktreeSession.worktreePath,
            originalCwd: worktreeSession.originalCwd,
            originalBranch: worktreeSession.originalBranch,
            originalHeadCommit: worktreeSession.originalHeadCommit,
          }
        : null,
    [worktreeSession],
  );

  // Layout measurements
  const mainControlsRef = useRef<DOMElement>(null);
  const lastTitleRef = useRef<string | null>(null);
  const [startupWarnings, setStartupWarnings] = useState(
    () => props.startupWarnings || [],
  );
  const staticExtraHeight = 3;

  // Prefetch the lowlight chunk on mount so the dynamic import is already
  // in flight before the first code block needs colorizing. Without this
  // kick-off, code blocks committed to ink's append-only <Static> region
  // before the import resolves stay plain text for the rest of the session
  // — Static can only be re-rendered via `refreshStatic`, which is not
  // wired to lowlight load completion. Common reachable paths: short
  // `--prompt -p` runs that finalize quickly, Ctrl+C-cancelled first turns,
  // and the first-paint history replay on `--resume`. Firing the load
  // from mount keeps the startup parse-cost win (V8 still parses off the
  // critical path) while restoring the "first paint sees a loaded
  // instance" guarantee. Errors are silently swallowed; CodeColorizer
  // already falls back to plain text on miss.
  useEffect(() => {
    void loadLowlight().catch((err) => {
      // The loader caches rejection with a cooldown (see
      // `LOWLIGHT_RETRY_COOLDOWN_MS` / `lowlightLastFailureAt` in
      // `lowlightLoader.ts`). This useEffect runs once on mount, so this
      // catch fires at most once per session regardless. Log to the debug
      // channel so a degraded syntax-highlight state (corrupted install,
      // missing chunk) leaves a breadcrumb without spamming the user's
      // TTY — `CodeColorizer` already falls back to plain text.
      debugLogger.warn(
        `Failed to load lowlight chunk; code blocks will render as plain text: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, []);

  // Initialize config (runs once on mount)
  useEffect(() => {
    (async () => {
      // Note: the program will not work if this fails so let errors be
      // handled by the global catch.
      profileCheckpoint('config_initialize_start');
      await config.initialize();
      setStartupWarnings((currentWarnings) =>
        mergeStartupWarnings(currentWarnings, config.getWarnings()),
      );
      profileCheckpoint('config_initialize_end');
      setConfigInitialized(true);
      profileCheckpoint('input_enabled');
      // Profile finalize is intentionally NOT here. With PR-A's background
      // MCP discovery, MCP-related events (`mcp_server_ready:*`,
      // `mcp_first_tool_registered`, `mcp_all_servers_settled`,
      // `gemini_tools_updated`) arrive AFTER `input_enabled`. The dedicated
      // `useEffect` below (gated by `configInitialized`) defers finalize
      // until MCP discovery settles or the 35s hard cap elapses — that way
      // the profile captures the full MCP timeline without holding back
      // the user-facing TTI.

      // Phase D-1: when launched with --worktree, gemini.tsx stashes a
      // one-shot notice on Config. Consume it here so it surfaces in the
      // transcript AND gets injected into the next user prompt. This
      // wins over the Phase C resume-restore path below — startup beats
      // resume on the same prompt.
      const startupWorktreeNotice =
        config.consumePendingStartupWorktreeNotice();
      if (startupWorktreeNotice) {
        historyManager.addItem(
          { type: MessageType.INFO, text: startupWorktreeNotice },
          Date.now(),
        );
        pendingWorktreeNoticeRef.current = startupWorktreeNotice;
      }

      const resumedSessionData = config.getResumedSessionData();
      if (resumedSessionData) {
        const rawItems = buildResumedHistoryItems(resumedSessionData, config);
        const collapseOnResume =
          settings.merged.ui?.history?.collapseOnResume ?? false;

        const historyItems = applyCollapsePolicyAndSummary(
          rawItems,
          collapseOnResume,
        );
        historyManager.loadHistory(historyItems);

        // Seed the prompt counter from the resumed conversation so new
        // promptIds don't collide with restored file history snapshots.
        const userTurnCount = resumedSessionData.conversation.messages.filter(
          (m) => m.type === 'user' && m.subtype !== 'mid_turn_user_message',
        ).length;
        if (userTurnCount > 0) {
          seedPromptCount(userTurnCount);
        }

        // Re-arm any `/goal` that was active when the prior session ended.
        try {
          restoreGoalFromHistory(historyItems, config, historyManager.addItem);
        } catch {
          // Restore is best-effort — never block resume on it.
        }

        const recovered = await config.loadPausedBackgroundAgents(
          config.getSessionId(),
        );
        if (recovered.length > 0) {
          historyManager.addItem(
            {
              type: MessageType.INFO,
              text: config
                .getBackgroundAgentResumeService()
                .buildRecoveredBackgroundAgentsNotice(recovered.length),
            },
            Date.now(),
          );
        }

        // Restore session name tag from custom title
        const title = config
          .getSessionService()
          .getSessionTitle(config.getSessionId());
        if (title) {
          setSessionName(title);
        }

        // Restore worktree context (shared logic — headless and ACP use
        // the same helper). Stale sidecars get cleaned up; live ones
        // produce an INFO message the model sees on the next turn.
        // Skipped when Phase D-1 already injected a --worktree startup
        // notice above (startup wins over resume on the same prompt).
        if (!startupWorktreeNotice) {
          try {
            const sessionPath = config
              .getSessionService()
              .getWorktreeSessionPath(config.getSessionId());
            const restored = await restoreWorktreeContext(
              sessionPath,
              (err) => {
                // eslint-disable-next-line no-console
                console.debug('worktree session restore warning:', err);
              },
            );
            if (restored.contextMessage) {
              // UI: show the notice in the transcript so the user knows.
              historyManager.addItem(
                { type: MessageType.INFO, text: restored.contextMessage },
                Date.now(),
              );
              // Model: queue the notice for one-shot injection into the
              // next user prompt (consumed by handleFinalSubmit). The INFO
              // history item alone is UI-only — the model never sees it,
              // so without this it could resume editing the parent
              // checkout despite the user seeing the worktree path.
              pendingWorktreeNoticeRef.current = restored.contextMessage;
            }
          } catch (error) {
            // Best-effort: failures here only affect UI hint visibility,
            // not the resumed conversation itself.
            // eslint-disable-next-line no-console
            console.debug('worktree session restore failed:', error);
          }
        }
      }
    })();

    // Register SessionEnd cleanup for process exit
    registerCleanup(async () => {
      try {
        await config
          .getHookSystem()
          ?.fireSessionEndEvent(SessionEndReason.PromptInputExit);
        debugLogger.debug('SessionEnd event completed successfully!!!');
      } catch (err) {
        debugLogger.error(`SessionEnd hook failed: ${err}`);
      }
    });

    registerCleanup(async () => {
      const ideClient = await IdeClient.getInstance();
      await ideClient.disconnect();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  /**
   * PR-A wiring: progressive MCP availability.
   *
   * This effect does two coupled things, both gated on `configInitialized`:
   *
   * 1. **16ms batch-flush of `setTools()`**: as each MCP server completes
   *    discover, `McpClientManager` emits `mcp-client-update`. We coalesce
   *    these into at most one `GeminiClient.setTools()` call per ~16ms
   *    window. With three MCP servers settling within a few ms of each
   *    other, the model sees one consolidated tool refresh instead of
   *    three back-to-back; with a server stream over 1s, the model sees
   *    each batch with at most one frame of lag (this is the gap the
   *    baseline measured at 6235 ms in three-mixed-mcp before PR-A).
   *
   * 2. **Deferred startup-profile finalize**: in PR-A's default mode
   *    MCP discovery runs in the background, so MCP-related profiler
   *    events arrive AFTER `input_enabled`. The profile file is held open
   *    until either the manager's discovery state reaches `COMPLETED`
   *    (all servers ready or failed) or `STARTUP_PROFILE_FINALIZE_CAP_MS`
   *    elapses (so a hung server doesn't keep the profile open forever).
   *
   * In legacy blocking mode (`QWEN_CODE_LEGACY_MCP_BLOCKING=1`) MCP
   * discovery already completed inside `config.initialize()`, so this
   * effect observes `MCPDiscoveryState.COMPLETED` immediately and finalizes
   * without waiting.
   */
  useEffect(() => {
    if (!isConfigInitialized) return undefined;
    const geminiClient = config.getGeminiClient();
    if (!geminiClient) return undefined;

    const manager = config.getToolRegistry().getMcpClientManager();
    let flushTimer: NodeJS.Timeout | null = null;
    let finalized = false;

    const finalizeOnce = () => {
      if (finalized) return;
      finalized = true;
      finalizeStartupProfile(config.getSessionId());
    };

    // Runs the pending batched setTools() immediately and clears the timer.
    // Returns a promise that resolves when setTools() finishes so callers
    // can sequence subsequent work after `gemini_tools_updated` is
    // recorded into the startup profile.
    const flushNow = (): Promise<void> => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // GeminiClient.setTools() has no try/catch around warmAll() /
      // getFunctionDeclarations() / getChat().setTools(). A silent
      // discard here would make production tool-registration regressions
      // invisible, so route the error through debugLogger.
      return geminiClient.setTools().catch((err) => {
        debugLogger.error(
          `setTools() batch-flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushNow();
      }, MCP_BATCH_FLUSH_MS);
    };

    // Match the non-interactive entry points (`gemini.tsx`, `session.ts`,
    // `acpAgent.ts`) which warn to stderr when MCP discovery completes with
    // failed servers. The interactive path can't use stderr (it would
    // collide with Ink's rendered output), so we route through
    // `debugLogger.warn` so it shows up under `QWEN_CODE_DEBUG=1` and in
    // the debug log file — matching the channel `setTools()` errors above
    // use. The MCP status footer pill already surfaces failures
    // continuously in the UI; this log is the actionable-on-debug record
    // wenshao asked for in round 7.
    let failureSurfaced = false;
    const surfaceFailuresOnce = () => {
      if (failureSurfaced) return;
      failureSurfaced = true;
      const failedNames =
        typeof config.getFailedMcpServerNames === 'function'
          ? config.getFailedMcpServerNames()
          : [];
      if (failedNames.length > 0) {
        debugLogger.warn(
          `MCP server(s) failed to start: ${failedNames.join(', ')}. ` +
            `Continuing with built-in tools and any servers that did connect.`,
        );
      }
    };

    const onMcpUpdate = () => {
      if (manager.getDiscoveryState() === MCPDiscoveryState.COMPLETED) {
        // Discovery has settled. Flush the pending setTools() NOW (rather
        // than waiting for the 16ms batch timer) and only finalize after
        // it runs — `setTools()` emits the `gemini_tools_updated` event,
        // and finalizing before it fires would drop that event because
        // the module-level `finalized` guard suppresses every subsequent
        // record. That dropped event is what `gemini_tools_lag` is
        // derived from in the profile summary.
        surfaceFailuresOnce();
        void flushNow().finally(finalizeOnce);
      } else {
        scheduleFlush();
      }
    };

    // Legacy / no-MCP path: discovery already finished synchronously
    // inside config.initialize(), so finalize immediately and only keep
    // the flush listener around for late refreshes (e.g. SkillTool's
    // post-construction refreshSkills triggering setTools).
    if (manager.getDiscoveryState() === MCPDiscoveryState.COMPLETED) {
      surfaceFailuresOnce();
      finalizeOnce();
    }

    appEvents.on('mcp-client-update', onMcpUpdate);
    const finalizeCap = setTimeout(
      finalizeOnce,
      STARTUP_PROFILE_FINALIZE_CAP_MS,
    );

    return () => {
      appEvents.off('mcp-client-update', onMcpUpdate);
      if (flushTimer !== null) clearTimeout(flushTimer);
      clearTimeout(finalizeCap);
    };
  }, [isConfigInitialized, config]);

  // Track idle state via ref so the update handler can defer notifications
  // while the model is streaming, without triggering re-renders.
  // Note: isIdleRef.current is assigned after streamingState becomes available
  // (see the assignment below useGeminiStream).
  const isIdleRef = useRef(true);
  const updateHandlerRef = useRef<{
    cleanup: () => void;
    flush: () => void;
  } | null>(null);

  useEffect(() => {
    const handler = setUpdateHandler(
      historyManager.addItem,
      setUpdateInfo,
      isIdleRef,
    );
    updateHandlerRef.current = handler;
    return () => handler?.cleanup();
  }, [historyManager.addItem]);

  // Derive widths for InputPrompt using shared helper
  const { inputWidth, suggestionsWidth } = useMemo(() => {
    const { inputWidth, suggestionsWidth } =
      calculatePromptWidths(terminalWidth);
    return { inputWidth, suggestionsWidth };
  }, [terminalWidth]);
  // Uniform width for bordered box components: accounts for margins and caps at 100
  const mainAreaWidth = Math.min(terminalWidth - 4, 100);
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);

  const isValidPath = useCallback((filePath: string): boolean => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_e) {
      return false;
    }
  }, []);

  const preferredEditor = usePreferredEditor();

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
    shellModeActive,
    preferredEditor,
  });

  useEffect(() => {
    const fetchUserMessages = async () => {
      const pastMessagesRaw = (await logger?.getPreviousUserMessages()) || [];
      const currentSessionUserMessages = historyManager.history
        .filter(
          (item): item is HistoryItem & { type: 'user'; text: string } =>
            item.type === 'user' &&
            typeof item.text === 'string' &&
            item.text.trim() !== '',
        )
        .map((item) => item.text)
        .reverse();
      // Current-session messages are already newest-first; combining with past
      // messages gives a newest-first list. dedupeNewestFirst keeps the first
      // (newest) occurrence so resubmitting an old prompt promotes it to
      // "most recent" rather than leaving a stale copy at an older position.
      const combinedMessages = [
        ...currentSessionUserMessages,
        ...pastMessagesRaw,
      ];
      setUserMessages(dedupeNewestFirst(combinedMessages).reverse());
    };
    fetchUserMessages();
  }, [historyManager.history, logger]);

  const remountStaticHistory = useCallback(() => {
    setHistoryRemountKey((prev) => prev + 1);
  }, []);

  // In VP mode (ui.useTerminalBuffer) the React tree fully owns the visible
  // region via ink 7 native overflow clipping. Writing clearTerminal /
  // cursorTo+eraseDown would be a wasted flash and would also corrupt the
  // in-app scroll position. The remount-key bump is also a near-no-op for
  // VP: nothing in the VP render path is keyed by historyRemountKey, so
  // the only reason to bump it is to keep the legacy `<Static>` branch in
  // sync if the user toggles `useTerminalBuffer` off mid-session. The
  // visible refresh in VP mode comes for free from the React tree
  // re-reading `mergedHistory` / `allVirtualItems` on whatever state
  // change triggered refreshStatic (Ctrl+O, model change, etc.).
  const useTerminalBuffer = settings.merged.ui?.useTerminalBuffer ?? false;
  const refreshStatic = useCallback(() => {
    if (!useTerminalBuffer) {
      stdout.write(ansiEscapes.clearTerminal);
    }
    remountStaticHistory();
  }, [useTerminalBuffer, remountStaticHistory, stdout]);

  // Keep the static header in sync with model changes without polling.
  // Ink's <Static> output is append-only, so model changes must explicitly
  // clear and remount the static region to redraw the banner at the top.
  //
  // Two requirements pull in opposite directions:
  //   (a) refreshStatic() must NOT be called from inside a setState updater,
  //       because React.StrictMode double-invokes updaters in dev and we'd
  //       fire two clearTerminal writes per model swap.
  //   (b) setHistoryRemountKey (inside refreshStatic) and setCurrentModel
  //       MUST land in the SAME commit. MainContent's <Static> key is
  //       `${historyRemountKey}-${currentModel}` and its render-phase
  //       progressive-replay reset (lastRemountKey !== historyRemountKey)
  //       only fires when historyRemountKey changes. If currentModel
  //       changes first in its own render, Static remounts with the OLD
  //       remount key and the unreset (full-length) replayCount — i.e.
  //       a full-history Static render that bypasses progressive replay
  //       (the issue #3899 freeze regression). See PR #4119 review.
  //
  // Fix: side-effect lives in the event handler (NOT the updater); a ref
  // guard de-dupes same-model notifications. React batches the
  // setHistoryRemountKey (via refreshStatic) and setCurrentModel calls in
  // this event handler into a single commit, so the render-phase reset
  // and the Static remount happen together — no full-history flash.
  const lastNotifiedModelRef = useRef(currentModel);
  useEffect(() => {
    const unsubscribe = config.onModelChange((model) => {
      if (lastNotifiedModelRef.current === model) {
        return;
      }
      lastNotifiedModelRef.current = model;
      refreshStatic();
      setCurrentModel(model);
    });
    return unsubscribe;
  }, [config, refreshStatic]);

  const {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(
    settings,
    setThemeError,
    historyManager.addItem,
    initializationResult.themeError,
  );

  const {
    isApprovalModeDialogOpen,
    openApprovalModeDialog,
    handleApprovalModeSelect,
  } = useApprovalModeCommand(settings, config);

  const auth = useAuthCommand(
    settings,
    config,
    historyManager.addItem,
    refreshStatic,
  );
  const { state: authState, actions: authActions } = auth;
  const { onAuthError, openAuthDialog, closeAuthDialog } = authActions;
  const { isAuthDialogOpen, isAuthenticating, pendingAuthType } = authState;

  useInitializationAuthError(initializationResult.authError, onAuthError);

  // Sync user tier from config when authentication changes
  // TODO: Implement getUserTier() method on Config if needed
  // useEffect(() => {
  //   if (authState === AuthState.Authenticated) {
  //     setUserTier(config.getUserTier());
  //   }
  // }, [config, authState]);

  // Check for enforced auth type mismatch
  useEffect(() => {
    // Check for initialization error first
    const currentAuthType = config.getModelsConfig().getCurrentAuthType();

    if (
      settings.merged.security?.auth?.enforcedType &&
      currentAuthType &&
      settings.merged.security?.auth.enforcedType !== currentAuthType
    ) {
      onAuthError(
        t(
          'Authentication is enforced to be {{enforcedType}}, but you are currently using {{currentType}}.',
          {
            enforcedType: String(settings.merged.security?.auth.enforcedType),
            currentType: String(currentAuthType),
          },
        ),
      );
    }
  }, [settings.merged.security?.auth?.enforcedType, config, onAuthError]);

  const [editorError, setEditorError] = useState<string | null>(null);
  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, historyManager.addItem);

  const { isSettingsDialogOpen, openSettingsDialog, closeSettingsDialog } =
    useSettingsCommand();
  const [isStatusLineDialogOpen, setStatusLineDialogOpen] = useState(false);
  const openStatusLineDialog = useCallback(
    () => setStatusLineDialogOpen(true),
    [],
  );
  const closeStatusLineDialog = useCallback(
    () => setStatusLineDialogOpen(false),
    [],
  );
  const [statusLineSettingsVersion, setStatusLineSettingsVersion] = useState(0);
  const [statusLineConfigOverride, setStatusLineConfigOverride] = useState<
    StatusLinePresetConfig | undefined
  >(undefined);
  const notifyStatusLineSettingsChanged = useCallback(
    (newConfig: StatusLinePresetConfig) => {
      setStatusLineConfigOverride(newConfig);
      setStatusLineSettingsVersion((version) => version + 1);
    },
    [],
  );
  const { isMemoryDialogOpen, openMemoryDialog, closeMemoryDialog } =
    useMemoryDialog();

  const {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    openModelDialog,
    closeModelDialog,
  } = useModelCommand();
  const { activeArenaDialog, openArenaDialog, closeArenaDialog } =
    useArenaCommand();

  // Session name state (set via /rename, restored on /resume)
  const [sessionName, setSessionName] = useState<string | null>(null);

  useEffect(() => {
    const chatRecordingService = config.getChatRecordingService();
    if (!chatRecordingService?.setTitleRecordedCallback) return;

    // Chain with existing callback (e.g., Session's ACP notification)
    const existingCallback = chatRecordingService.getTitleRecordedCallback();
    chatRecordingService.setTitleRecordedCallback((customTitle, source) => {
      existingCallback?.(customTitle, source);
      setSessionName(customTitle);
    });

    return () => {
      // Restore original callback on unmount
      chatRecordingService.setTitleRecordedCallback(existingCallback);
    };
  }, [config]);

  const {
    isResumeDialogOpen,
    resumeMatchedSessions,
    openResumeDialog,
    closeResumeDialog,
    handleResume,
  } = useResumeCommand({
    config,
    settings,
    historyManager,
    startNewSession,
    setSessionName,
    remount: refreshStatic,
  });

  const { handleBranch } = useBranchCommand({
    config,
    settings,
    historyManager,
    startNewSession,
    setSessionName,
    remount: refreshStatic,
  });

  const {
    isDeleteDialogOpen,
    openDeleteDialog,
    closeDeleteDialog,
    handleDelete,
    handleDeleteMany,
  } = useDeleteCommand({
    config,
    addItem: historyManager.addItem,
  });

  const [isHelpDialogOpen, setHelpDialogOpen] = useState(false);
  const [activeHelpTab, setHelpTab] = useState<
    'general' | 'commands' | 'custom-commands'
  >('general');
  const openHelpDialog = useCallback(() => setHelpDialogOpen(true), []);
  const closeHelpDialog = useCallback(() => setHelpDialogOpen(false), []);

  const { vimEnabled, vimMode } = useVimModeState();
  const { toggleVimEnabled } = useVimModeActions();

  const {
    isSubagentCreateDialogOpen,
    openSubagentCreateDialog,
    closeSubagentCreateDialog,
  } = useSubagentCreateDialog();
  const {
    isAgentsManagerDialogOpen,
    openAgentsManagerDialog,
    closeAgentsManagerDialog,
  } = useAgentsManagerDialog();
  const {
    isSkillsManagerDialogOpen,
    openSkillsManagerDialog,
    closeSkillsManagerDialog,
  } = useSkillsManagerDialog();
  const {
    isExtensionsManagerDialogOpen,
    openExtensionsManagerDialog,
    closeExtensionsManagerDialog,
  } = useExtensionsManagerDialog();
  const { isMcpDialogOpen, openMcpDialog, closeMcpDialog } = useMcpDialog();
  const { isHooksDialogOpen, openHooksDialog, closeHooksDialog } =
    useHooksDialog();
  const { isStatsDialogOpen, openStatsDialog, closeStatsDialog } =
    useStatsDialog();

  // Ref bridge: the guarded openRewindSelector callback is defined later
  // (after useDoublePress), but slashCommandActions needs it now. The ref
  // lets the useMemo capture a stable function pointer whose implementation
  // is swapped in once the real callback exists.
  const openRewindSelectorRef = useRef<() => void>(() => {});

  // /diff opens a per-turn diff dialog. Unlike rewind, no double-press or
  // history-bound guard is needed, so the open/close handlers can live here
  // (no ref bridge required).
  const [isDiffDialogOpen, setIsDiffDialogOpen] = useState(false);
  const openDiffDialog = useCallback(() => {
    setIsDiffDialogOpen(true);
  }, []);
  const closeDiffDialog = useCallback(() => {
    setIsDiffDialogOpen(false);
  }, []);

  const slashCommandActions = useMemo(
    () => ({
      openAuthDialog,
      openThemeDialog,
      openEditorDialog,
      openMemoryDialog,
      openSettingsDialog,
      openStatusLineDialog,
      openModelDialog,
      openTrustDialog,
      openArenaDialog,
      openPermissionsDialog,
      openApprovalModeDialog,
      quit: (messages: HistoryItem[]) => {
        setQuittingMessages(messages);
        // Signal the client to skip background memory tasks (extract, dream,
        // skill review) so the process can exit without spawning new agent
        // work during the exit window.
        config.getGeminiClient()?.requestShutdown();
        setTimeout(async () => {
          await runExitCleanup();
          process.exit(0);
        }, 100);
      },
      setDebugMessage,
      dispatchExtensionStateUpdate,
      addConfirmUpdateExtensionRequest,
      openSubagentCreateDialog,
      openAgentsManagerDialog,
      openSkillsManagerDialog,
      openExtensionsManagerDialog,
      openMcpDialog,
      openHooksDialog,
      openStatsDialog,
      openResumeDialog,
      openRewindSelector: () => openRewindSelectorRef.current(),
      openDiffDialog,
      handleResume,
      handleBranch,
      openDeleteDialog,
      openHelpDialog,
    }),
    [
      openAuthDialog,
      openThemeDialog,
      openEditorDialog,
      openMemoryDialog,
      openSettingsDialog,
      openStatusLineDialog,
      openModelDialog,
      openArenaDialog,
      setDebugMessage,
      dispatchExtensionStateUpdate,
      openTrustDialog,
      openPermissionsDialog,
      openApprovalModeDialog,
      addConfirmUpdateExtensionRequest,
      openSubagentCreateDialog,
      openAgentsManagerDialog,
      openSkillsManagerDialog,
      openExtensionsManagerDialog,
      openMcpDialog,
      openHooksDialog,
      openStatsDialog,
      openResumeDialog,
      handleResume,
      handleBranch,
      openDeleteDialog,
      openHelpDialog,
      openDiffDialog,
      config,
    ],
  );

  const {
    handleSlashCommand,
    slashCommands,
    recentSlashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    btwItem,
    setBtwItem,
    cancelBtw,
    commandContext,
    shellConfirmationRequest,
    confirmationRequest,
    reloadCommands,
  } = useSlashCommandProcessor(
    config,
    settings,
    historyManager.history,
    historyManager.addItem,
    historyManager.clearItems,
    historyManager.loadHistory,
    refreshStatic,
    toggleVimEnabled,
    isProcessing,
    setIsProcessing,
    isIdleRef,
    setGeminiMdFileCount,
    slashCommandActions,
    extensionsUpdateStateInternal,
    isConfigInitialized,
    logger,
    historyManager.updateItem,
    setSessionName,
  );

  // onDebugMessage should log to debug logfile, not update footer debugMessage
  const onDebugMessage = useCallback(
    (message: string) => {
      config.getDebugLogger().debug(message);
    },
    [config],
  );

  const handleWorktreeExit = useCallback(
    async (choice: 'keep' | 'remove' | 'cancel') => {
      if (choice === 'cancel') {
        setShowWorktreeExitDialog(false);
        return;
      }
      setShowWorktreeExitDialog(false);
      if (choice === 'remove' && activeWorktree) {
        try {
          // Anchor at the repo top-level (captured at enter time) rather
          // than the current targetDir — when the CLI was launched from
          // a monorepo subdirectory, `config.getTargetDir()` is that
          // subdir but the worktree lives at `<repoRoot>/.qwen/worktrees/`,
          // so a service rooted at the subdir would never find it. (PR
          // #4174 review finding 3252368637.)
          const svc = new GitWorktreeService(activeWorktree.originalCwd);
          // Ownership guard — read the in-worktree session marker and
          // refuse to remove a worktree owned by a different session
          // (stale sidecar, copied state from another machine, etc.).
          // Mirrors the guard ExitWorktreeTool applies on the model
          // path; without it the dialog could destroy a worktree it
          // doesn't own. (PR #4174 review #3259975247.)
          const owner = await readWorktreeSessionMarker(activeWorktree.path);
          const currentSessionId = config.getSessionId();
          if (owner !== null && owner !== currentSessionId) {
            const ownerActive = await isSessionRuntimeActive(owner, [
              activeWorktree.originalCwd,
              activeWorktree.path,
            ]).catch((error) => {
              config
                .getDebugLogger()
                .warn(
                  `Worktree owner runtime check failed for ${owner}: ${error}`,
                );
              return true;
            });
            if (ownerActive) {
              historyManager.addItem(
                {
                  type: MessageType.ERROR,
                  text:
                    `Refusing to remove worktree "${activeWorktree.slug}" — ` +
                    `it was created by a different session (owner=${owner}). ` +
                    `Resume the owning session to drop it, or remove it ` +
                    `manually with \`git worktree remove ${activeWorktree.path}\`.`,
                },
                Date.now(),
              );
              return;
            }
          }
          // The user just clicked Remove on a dialog that already showed
          // the dirty-state and unmerged-commit counts ("discards N
          // commits, M files"). Force-delete the branch to honour that
          // intent — without it, `git branch -d` refuses unmerged
          // commits and the branch is silently preserved, contradicting
          // the dialog text. (Finding 3252368640 part 2.)
          const result = await svc.removeUserWorktree(activeWorktree.slug, {
            deleteBranch: true,
            forceDeleteBranch: true,
          });
          // removeUserWorktree returns {success, error} on failure — it
          // does NOT throw — so the previous try/catch never tripped on
          // a soft failure. If removal failed, leave the sidecar intact
          // so the next --resume can still see the worktree. Surface
          // the error in history and stay in the session so the user
          // can decide what to do (retry via exit_worktree, fix the
          // underlying problem, or force-quit). Previously the dialog
          // silently /quit on failure, contradicting the "discards N
          // commits, M files" intent the user clicked Remove on.
          // (Findings 3252368640 part 1 + 3256237933.)
          if (!result.success) {
            historyManager.addItem(
              {
                type: MessageType.ERROR,
                text:
                  `Failed to remove worktree "${activeWorktree.slug}": ` +
                  `${result.error ?? 'unknown error'}. The worktree is ` +
                  `still on disk; use \`exit_worktree\` to retry or ` +
                  `remove it manually with \`git worktree remove\`.`,
              },
              Date.now(),
            );
            return;
          }
          await clearWorktreeSession(
            config
              .getSessionService()
              .getWorktreeSessionPath(config.getSessionId()),
          );
        } catch (error) {
          // Hard failure (e.g. git binary missing, GitWorktreeService
          // constructor threw). Same treatment as the soft failure
          // path: surface to the user and stay alive — silent /quit
          // here would leave the user wondering whether the worktree
          // was actually removed.
          historyManager.addItem(
            {
              type: MessageType.ERROR,
              text:
                `Worktree removal failed for "${activeWorktree.slug}": ` +
                `${error instanceof Error ? error.message : String(error)}. ` +
                `Use \`exit_worktree\` or remove it manually.`,
            },
            Date.now(),
          );
          return;
        }
      }
      handleSlashCommand('/quit');
    },
    [activeWorktree, config, handleSlashCommand, historyManager],
  );

  const performMemoryRefresh = useCallback(async () => {
    historyManager.addItem(
      {
        type: MessageType.INFO,
        text: 'Refreshing hierarchical memory (QWEN.md or other context files)...',
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount, conditionalRules, projectRoot } =
        await loadHierarchicalGeminiMemory(
          process.cwd(),
          settings.merged.context?.loadFromIncludeDirectories
            ? config.getWorkspaceContext().getDirectories()
            : [],
          config.getFileService(),
          config.getExtensionContextFilePaths(),
          config.isTrustedFolder(),
          settings.merged.context?.importFormat || 'tree', // Use setting or default to 'tree'
          config.getContextRuleExcludes(),
          {
            loadReason: 'refresh',
            onInstructionsLoaded: createInstructionsLoadedCallback(() =>
              config.getHookSystem(),
            ),
          },
        );

      config.setUserMemory(memoryContent);
      config.setGeminiMdFileCount(fileCount);
      config.setConditionalRulesRegistry(
        new ConditionalRulesRegistry(conditionalRules, projectRoot),
      );
      setGeminiMdFileCount(fileCount);

      historyManager.addItem(
        {
          type: MessageType.INFO,
          text: `Memory refreshed successfully. ${
            memoryContent.length > 0
              ? `Loaded ${memoryContent.length} characters from ${fileCount} file(s).`
              : 'No memory content found.'
          }`,
        },
        Date.now(),
      );
      debugLogger.debug(
        `[DEBUG] Refreshed memory content in config: ${memoryContent.substring(
          0,
          200,
        )}...`,
      );
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      historyManager.addItem(
        {
          type: MessageType.ERROR,
          text: `Error refreshing memory: ${errorMessage}`,
        },
        Date.now(),
      );
      debugLogger.error('Error refreshing memory:', error);
    }
  }, [config, historyManager, settings.merged]);

  const cancelHandlerRef = useRef<(info?: CancelSubmitInfo) => void>(() => {});
  const midTurnDrainRef = useRef<(() => string[]) | null>(null);

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
    cancelOngoingRequest,
    retryLastPrompt,
    handleApprovalModeChange,
    activePtyId,
    loopDetectionConfirmationRequest,
    pendingToolCalls,
    streamingResponseLengthRef,
    isReceivingContent,
  } = useGeminiStream(
    config.getGeminiClient(),
    historyManager.history,
    historyManager.addItem,
    config,
    isConfigInitialized,
    settings,
    onDebugMessage,
    handleSlashCommand,
    shellModeActive,
    () => settings.merged.general?.preferredEditor as EditorType,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
    refreshStatic,
    (info) => cancelHandlerRef.current(info),
    setEmbeddedShellFocused,
    terminalWidth,
    terminalHeight,
    midTurnDrainRef,
    logger,
  );

  // Now that streamingState is available, keep isIdleRef in sync and
  // flush any deferred update notifications when the model finishes responding.
  isIdleRef.current = streamingState === StreamingState.Idle;

  useEffect(() => {
    if (streamingState === StreamingState.Idle) {
      updateHandlerRef.current?.flush();
      // P7-trigger: a steered turn has finished — drop the `workflow active`
      // indicator until the next keyword prompt re-arms it.
      setWorkflowKeywordActive(false);
    }
  }, [streamingState]);

  // Contextual tips — show tips based on context usage after model responses
  // Defer TipHistory loading when tips are disabled to avoid side effects
  // (sessionCount increment + disk write) when the user has opted out.
  const tipsDisabled = !!(
    settings.merged.ui?.hideTips || config.getScreenReader()
  );
  const tipHistory = useMemo(
    () => (tipsDisabled ? null : getTipHistory()),
    [tipsDisabled],
  );
  useContextualTips({
    streamingState,
    lastPromptTokenCount: sessionStats.lastPromptTokenCount,
    sessionPromptCount: sessionStats.promptCount,
    config,
    tipHistory,
    addItem: historyManager.addItem,
    hideTips: tipsDisabled,
  });

  // Track whether the input area has any Tab consumer (autocomplete dropdown,
  // followup suggestion, mid-input ghost text, reverse/command search). When
  // true, we suppress the Windows-only "bare Tab cycles approval mode"
  // fallback so a single Tab keystroke triggers only one action. See #4171.
  const [hasTabConsumer, setHasTabConsumer] = useState(false);

  const agentViewState = useAgentViewState();
  const { dialogOpen: bgTasksDialogOpen } = useBackgroundTaskViewState();
  const { closeDialog: closeBgTasksDialog } = useBackgroundTaskViewActions();

  // Prompt suggestion state
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const prevStreamingStateRef = useRef<StreamingState>(StreamingState.Idle);
  const speculationRef = useRef<SpeculationState>(IDLE_SPECULATION);
  const suggestionAbortRef = useRef<AbortController | null>(null);

  // Aborts in-flight suggestion generation/speculation only. It deliberately
  // does NOT clear `promptSuggestion`, so the placeholder can restore the
  // suggestion when the buffer becomes empty again (user types then deletes).
  // Named "abort" (not "dismiss") precisely because the suggestion text
  // survives — see #5145 review.
  const abortPromptSuggestion = useCallback(() => {
    suggestionAbortRef.current?.abort();
    suggestionAbortRef.current = null;
    // Also abort the speculation so it doesn't continue running after abort.
    if (speculationRef.current.status !== 'idle') {
      abortSpeculation(speculationRef.current).catch(() => {});
      speculationRef.current = IDLE_SPECULATION;
    }
  }, []);

  // Auto-accept indicator — disabled on agent tabs (agents handle their own)
  const geminiClient = config.getGeminiClient();

  const showAutoAcceptIndicator = useAutoAcceptIndicator({
    config,
    settings,
    addItem: historyManager.addItem,
    onApprovalModeChange: handleApprovalModeChange,
    shouldBlockTab: () => hasTabConsumer,
    disabled: agentViewState.activeView !== 'main',
  });

  const {
    messageQueue,
    addMessage,
    popAllMessages,
    drainQueue,
    popNextSegment,
  } = useMessageQueue();

  // Bridge message queue to mid-turn drain via ref.
  // drainQueue reads the synchronous queueRef inside the hook, so it
  // stays consistent with popNextSegment even before React re-renders.
  midTurnDrainRef.current = drainQueue;

  // Connect remote input watcher to submitQuery for bidirectional sync.
  // When an external process writes a command to the input-file,
  // the watcher calls submitQuery as if the user typed it in the TUI.
  const remoteInput = useRemoteInput();
  useEffect(() => {
    if (!remoteInput) return;
    remoteInput.setSubmitFn((text: string) => submitQuery(text));
  }, [remoteInput, submitQuery]);

  // Notify remote input watcher when TUI becomes idle so it can
  // retry queued commands that were deferred while TUI was busy.
  useEffect(() => {
    if (!remoteInput) return;
    if (streamingState === StreamingState.Idle) {
      remoteInput.notifyIdle();
    }
  }, [remoteInput, streamingState]);

  // Dual-output tool-confirmation bridge.
  //
  // When a tool call enters awaiting_approval we emit a `control_request`
  // (subtype: can_use_tool) on the dual-output channel so an external
  // consumer can decide. Whichever side resolves first (TUI native UI or
  // `confirmation_response` written to --input-file) wins; we always emit
  // a `control_response` mirroring the final decision so observers stay in
  // sync.
  const dualOutput = useDualOutput();
  const confirmRequestMap = useRef(new Map<string, string>()); // requestId → callId
  const confirmCallIdMap = useRef(new Map<string, string>()); // callId → requestId
  const confirmEmitted = useRef(new Set<string>());

  useEffect(() => {
    if (!dualOutput || !dualOutput.isConnected) return;
    for (const tc of pendingToolCalls) {
      if (
        tc.status === 'awaiting_approval' &&
        !confirmEmitted.current.has(tc.request.callId)
      ) {
        const requestId = crypto.randomUUID();
        confirmRequestMap.current.set(requestId, tc.request.callId);
        confirmCallIdMap.current.set(tc.request.callId, requestId);
        confirmEmitted.current.add(tc.request.callId);
        dualOutput.emitPermissionRequest(
          requestId,
          tc.request.name,
          tc.request.callId,
          tc.request.args,
        );
      }
    }
    // Detect tools that left awaiting_approval (TUI-native resolution) so we
    // can emit a matching control_response back to external consumers.
    for (const [callId, requestId] of confirmCallIdMap.current) {
      const tc = pendingToolCalls.find((t) => t.request.callId === callId);
      if (
        tc &&
        tc.status !== 'awaiting_approval' &&
        confirmEmitted.current.has(callId)
      ) {
        const allowed = tc.status !== 'cancelled' && tc.status !== 'error';
        dualOutput.emitControlResponse(requestId, allowed);
        confirmRequestMap.current.delete(requestId);
        confirmCallIdMap.current.delete(callId);
        confirmEmitted.current.delete(callId);
      }
    }
  }, [dualOutput, pendingToolCalls]);

  // Keep latest state in refs so the confirmation handler (registered once)
  // always reads current values without needing re-registration.
  const pendingToolCallsRef = useRef(pendingToolCalls);
  pendingToolCallsRef.current = pendingToolCalls;
  const dualOutputRef = useRef(dualOutput);
  dualOutputRef.current = dualOutput;

  // Route confirmation_response commands written to --input-file back into
  // the tool's onConfirm handler. Registered once (deps: [remoteInput]) to
  // avoid teardown/re-registration churn on every pendingToolCalls change.
  useEffect(() => {
    if (!remoteInput) return;
    remoteInput.setConfirmationHandler(
      (requestId: string, allowed: boolean) => {
        const callId = confirmRequestMap.current.get(requestId);
        if (!callId) {
          dualOutputRef.current?.emitControlError(
            requestId,
            'unknown request_id (already resolved, cancelled, or never issued)',
          );
          return;
        }
        const tc = pendingToolCallsRef.current.find(
          (t) =>
            t.request.callId === callId && t.status === 'awaiting_approval',
        );
        if (!tc) {
          dualOutputRef.current?.emitControlError(
            requestId,
            'tool call is no longer awaiting approval',
          );
          return;
        }
        const waitingTc = tc as WaitingToolCall;
        if (!waitingTc.confirmationDetails?.onConfirm) {
          dualOutputRef.current?.emitControlError(
            requestId,
            'tool call has no onConfirm handler',
          );
          return;
        }
        void waitingTc.confirmationDetails.onConfirm(
          allowed
            ? ToolConfirmationOutcome.ProceedOnce
            : ToolConfirmationOutcome.Cancel,
        );
        // Do NOT clean up maps here — let the mirror useEffect (line ~870)
        // detect the state transition and emit control_response + clean up,
        // keeping the emission path symmetric for both TUI-native and
        // external-initiated resolutions.
      },
    );

    return () => {
      remoteInput.setConfirmationHandler(() => {});
    };
  }, [remoteInput]);

  // Callback for handling final submit (must be after addMessage from useMessageQueue)
  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      // Route to active in-process agent if viewing a sub-agent tab.
      if (agentViewState.activeView !== 'main') {
        const agent = agentViewState.agents.get(agentViewState.activeView);
        if (agent) {
          agent.interactiveAgent.enqueueMessage(submittedValue.trim());
          return;
        }
      }
      // The user's raw text, captured before any `<system-reminder>` prefix is
      // prepended below (so keyword detection sees only what the user typed).
      const userPromptText = submittedValue;
      // Phase C: one-shot worktree restore reminder. Set during --resume
      // when the persisted sidecar names a live worktree. We only inject
      // on top-level user prompts (not btw-during-response, not slash
      // commands — those go through different paths). Once consumed,
      // clear the ref so subsequent prompts aren't repeatedly prefixed.
      const worktreeNotice = pendingWorktreeNoticeRef.current;
      if (worktreeNotice && !isSlashCommand(submittedValue)) {
        pendingWorktreeNoticeRef.current = null;
        submittedValue =
          `<system-reminder>\n${worktreeNotice}\n</system-reminder>\n\n` +
          submittedValue;
      }
      // P7-trigger: when the user's prompt mentions `workflow`, softly steer
      // this turn toward the Workflow tool (same one-shot reminder mechanism
      // as the worktree notice). Detect on the user's original text — `notice`
      // above only adds system text, never the keyword. Gated on the feature
      // flag + the opt-out setting; skipped for slash commands. The model
      // keeps discretion, so a casual mention can't force a tool call.
      const workflowTriggerEnabled =
        config.isWorkflowsEnabled() &&
        !settings.merged.ui?.disableWorkflowKeywordTrigger;
      if (
        workflowTriggerEnabled &&
        !isSlashCommand(userPromptText) &&
        // Skip `?btw`/`/btw` side-questions: prefixing a system-reminder would
        // break the BTW routing check below (which tests `submittedValue`),
        // queuing the side question as a normal prompt instead.
        !isBtwCommand(userPromptText) &&
        detectWorkflowKeyword(userPromptText)
      ) {
        setWorkflowKeywordActive(true);
        logWorkflowKeyword(config, new WorkflowKeywordEvent());
        submittedValue =
          `<system-reminder>\n${buildWorkflowSteeringNotice()}\n</system-reminder>\n\n` +
          submittedValue;
      }
      if (
        streamingState === StreamingState.Responding &&
        isBtwCommand(submittedValue)
      ) {
        void submitQuery(submittedValue);
        return;
      }

      // Handle bare exit/quit commands (without the / prefix)
      if (
        ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'].includes(
          submittedValue.trim(),
        )
      ) {
        void handleSlashCommand('/quit');
        return;
      }

      // Check if speculation has results for this submission
      const spec = speculationRef.current;
      if (
        spec.status !== 'idle' &&
        spec.suggestion === submittedValue &&
        spec.status === 'completed'
      ) {
        // Accept completed speculation: inject messages and apply files
        acceptSpeculation(spec, geminiClient)
          .then((result) => {
            logSpeculation(
              config,
              new SpeculationEvent({
                outcome: 'accepted',
                turns_used: spec.messages.filter((m) => m.role === 'model')
                  .length,
                files_written: result.filesApplied.length,
                tool_use_count: spec.toolUseCount,
                duration_ms: Date.now() - spec.startTime,
                boundary_type: spec.boundary?.type,
                had_pipelined_suggestion: !!result.nextSuggestion,
              }),
            );
            // Speculation completed fully (no boundary) — render results in UI
            {
              const now = Date.now();

              // Render each speculated message as the appropriate HistoryItem
              for (let mi = 0; mi < result.messages.length; mi++) {
                const msg = result.messages[mi];
                if (msg.role === 'user' && msg.parts) {
                  // Check if this is a tool result (functionResponse) or user text
                  const hasText = msg.parts.some(
                    (p) => p.text && !p.functionResponse,
                  );
                  if (hasText) {
                    const text = msg.parts
                      .map((p) => p.text ?? '')
                      .filter(Boolean)
                      .join('');
                    if (text) {
                      historyManager.addItem(
                        { type: 'user' as const, text },
                        now,
                      );
                    }
                  }
                  // functionResponse parts are rendered as part of the tool_group below
                } else if (msg.role === 'model' && msg.parts) {
                  // Extract text and tool calls separately
                  const textParts = msg.parts
                    .filter((p) => p.text && !p.functionCall)
                    .map((p) => p.text!)
                    .join('');
                  const toolCalls = msg.parts.filter((p) => p.functionCall);

                  if (textParts) {
                    historyManager.addItem(
                      { type: 'gemini' as const, text: textParts },
                      now,
                    );
                  }

                  if (toolCalls.length > 0) {
                    // Find matching tool results from the next message
                    const nextMsg = result.messages[mi + 1];
                    const toolResults =
                      nextMsg?.parts?.filter((p) => p.functionResponse) ?? [];

                    const tools = toolCalls.map((tc, i) => {
                      const name = tc.functionCall?.name ?? 'unknown';
                      const args = tc.functionCall?.args ?? {};
                      const resp = toolResults[i]?.functionResponse?.response;
                      const resultText =
                        typeof resp === 'object' && resp
                          ? ((resp as Record<string, unknown>)['output'] ??
                            JSON.stringify(resp))
                          : String(resp ?? '');
                      return {
                        callId: `spec-${name}-${i}`,
                        name,
                        description:
                          Object.entries(args)
                            .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
                            .join(', ') || name,
                        resultDisplay: String(resultText).slice(0, 500),
                        status: ToolCallStatus.Success,
                        confirmationDetails: undefined,
                      };
                    });

                    const toolGroupItem: HistoryItemWithoutId = {
                      type: 'tool_group' as const,
                      tools,
                    };
                    historyManager.addItem(toolGroupItem, now);
                  }
                }
              }
            }
            if (result.nextSuggestion) {
              setPromptSuggestion(result.nextSuggestion);
            }
          })
          .catch(() => {
            // Fallback: submit normally
            addMessage(submittedValue);
          });
        speculationRef.current = IDLE_SPECULATION;
        return;
      }

      // Abort any running speculation since we're submitting something different
      if (spec.status === 'running') {
        abortSpeculation(spec).catch(() => {});
        speculationRef.current = IDLE_SPECULATION;
      }

      if (
        streamingState === StreamingState.Idle &&
        isSlashCommand(submittedValue)
      ) {
        void submitQuery(submittedValue);
        return;
      }

      addMessage(submittedValue);
    },
    [
      addMessage,
      agentViewState,
      streamingState,
      submitQuery,
      handleSlashCommand,
      config,
      geminiClient,
      historyManager,
      settings.merged.ui?.disableWorkflowKeywordTrigger,
    ],
  );

  const handleArenaModelsSelected = useCallback(
    (models: string[]) => {
      const value = models.join(',');
      buffer.setText(`/arena start --models ${value} `);
      closeArenaDialog();
    },
    [buffer, closeArenaDialog],
  );

  // Welcome back functionality (must be after handleFinalSubmit)
  const {
    welcomeBackInfo,
    showWelcomeBackDialog,
    welcomeBackChoice,
    handleWelcomeBackSelection,
    handleWelcomeBackClose,
  } = useWelcomeBack(config, handleFinalSubmit, buffer, settings.merged);

  const pendingHistoryItems = useMemo(
    () => [...pendingSlashCommandHistoryItems, ...pendingGeminiHistoryItems],
    [pendingSlashCommandHistoryItems, pendingGeminiHistoryItems],
  );
  const rawStickyTodos = useMemo(
    () => getStickyTodos(historyManager.history, pendingHistoryItems),
    [historyManager.history, pendingHistoryItems],
  );
  const stickyTodos = useStableStickyTodos(rawStickyTodos);

  // Terminal tab progress bar (OSC 9;4) for iTerm2/Ghostty
  useTerminalProgress(streamingState, isToolExecuting(pendingHistoryItems));

  cancelHandlerRef.current = useCallback(
    (info?: CancelSubmitInfo) => {
      // Combine the React-state pending items (slash command, retry countdown,
      // tool group, etc.) with the synchronous snapshot of the Gemini pending
      // item from `useGeminiStream`. The snapshot closes the race where a
      // stream chunk just set `pendingHistoryItem` but the consumer's React
      // state still reads as empty — without it, auto-restore could wrongly
      // truncate just-committed meaningful content.
      const pendingHistoryItems: HistoryItemWithoutId[] = [
        ...pendingSlashCommandHistoryItems,
        ...pendingGeminiHistoryItems,
      ];
      if (info?.pendingItem) {
        pendingHistoryItems.push(info.pendingItem);
      }
      const draftWasEmpty = buffer.text.length === 0;

      // Always drain the queue back into the buffer (claude-code parity:
      // popAllEditable preserves queued text on every cancel path, including
      // tool-execution cancels — never silently drop the user's queued work).
      const popped = popAllMessages();
      if (popped) {
        const currentText = buffer.text;
        buffer.setText(currentText ? `${popped}\n${currentText}` : popped);
      }

      // Auto-restore-on-cancel: if the user hit ESC immediately after submit
      // (nothing meaningful was produced), pull the just-submitted prompt back
      // into the input box and rewind the transcript so it doesn't show a
      // stranded "user prompt + Request cancelled." pair. Mirrors claude-code
      // (REPL.tsx auto-restore branch).
      //
      // Guards (all required):
      //   - Buffer was empty before the queue drain (don't clobber typed-during-
      //     loading text).
      //   - Queue was empty (popped === null): if the user queued more input,
      //     they've moved on — don't undo their previous prompt.
      //   - No pending stream item carries meaningful content. `tool_group` is
      //     non-synthetic regardless of status (executing/canceled/done), so
      //     this also covers the tool-execution cancel case.
      //   - Items committed AFTER the last user prompt are all synthetic
      //     (info/error/warning/cancel notice).
      //
      // truncateToItem is functional setState — it observes the latest queued
      // history, including any INFO/pending item just appended by
      // cancelOngoingRequest, and slices them all off together with the user
      // item. No flicker because React batches with the same render pass.
      // Each bail-out below is silent in production; toggle DEBUG=1 to
      // diagnose "ESC pressed but my prompt didn't return to the input box"
      // by reading which guard fired.
      if (!draftWasEmpty) {
        debugLogger.debug('auto-restore bail: buffer was non-empty');
        return;
      }
      if (popped !== null) {
        debugLogger.debug(
          'auto-restore bail: queue had items (drained to buffer)',
        );
        return;
      }
      if (pendingHistoryItems.some((item) => !isSyntheticHistoryItem(item))) {
        debugLogger.debug(
          'auto-restore bail: pending stream item has meaningful content',
        );
        return;
      }
      // Synchronous "did the turn produce any content event" flag from
      // useGeminiStream. Catches the race where the pre-cancel flush
      // committed gemini_content via addItem and a later thought event
      // overwrote pendingHistoryItem with a synthetic value — the
      // committed text isn't in historyRef.current yet (React hasn't
      // re-rendered), so the trailing-only-synthetic check below would
      // otherwise pass and we'd wrongly truncate the committed content.
      if (info?.turnProducedMeaningfulContent) {
        debugLogger.debug(
          'auto-restore bail: turn produced meaningful content during stream/flush',
        );
        return;
      }

      // The cancelled turn must have added a `user` history item itself —
      // Cron / Notification / slash submit_prompt / Retry paths submit
      // without pushing a user item, so an older user item that happens
      // to be followed only by synthetic content must NOT be wrongly
      // auto-restored on top of those turns.
      const cancelledTurnUserItem = info?.lastTurnUserItem;
      if (cancelledTurnUserItem == null) {
        debugLogger.debug(
          'auto-restore bail: cancelled turn did not add a user history item',
        );
        return;
      }

      const history = historyRef.current;
      const lastUserIdx = findLastUserItemIndex(history);
      if (lastUserIdx === -1) {
        debugLogger.debug('auto-restore bail: no user item in history');
        return;
      }
      if (!itemsAfterAreOnlySynthetic(history, lastUserIdx)) {
        debugLogger.debug(
          'auto-restore bail: meaningful content committed after last user item',
        );
        return;
      }

      const lastUserItem = history[lastUserIdx];
      if (lastUserItem.type !== 'user') {
        debugLogger.debug(
          'auto-restore bail: lastUserItem type narrowing failed (unexpected)',
        );
        return;
      }
      // Identity match: the user item we're rewinding has to be the one
      // this turn added. Use ID (not just text) so a consecutive-
      // duplicate user submit — where `addItem` skipped insertion but
      // still returned a fresh id — doesn't make this guard wrongly
      // match an older identical-text USER row. Text is checked too as
      // a cheap sanity belt.
      if (
        lastUserItem.id !== cancelledTurnUserItem.id ||
        lastUserItem.text !== cancelledTurnUserItem.text
      ) {
        debugLogger.debug(
          'auto-restore bail: lastUserItem identity does not match cancelled-turn user item',
        );
        return;
      }
      debugLogger.debug(
        'auto-restore: rewinding cancelled turn and restoring prompt',
      );
      historyManager.truncateToItem(lastUserItem.id);
      // Repaint the terminal so the cancelled `> prompt` and trailing
      // INFO disappear from the static-rendered transcript. Ink's
      // `<Static>` region is append-only — once a line has been printed,
      // shrinking the underlying array doesn't unprint it. `refreshStatic`
      // writes the ANSI clear-terminal escape AND bumps the static
      // remount key so the next render reprints only the truncated
      // history. Matches what `/clear` and `handleClearScreen` do for
      // the same reason. Skipping this leaves the user seeing the
      // cancelled prompt twice — once in scrollback and once pre-filled
      // in the input buffer.
      refreshStatic();
      buffer.setText(lastUserItem.text);
      // Third cleanup leg: the in-memory chat history. `GeminiChat`
      // appends the user content before the stream generator runs, and
      // the abort path doesn't pop it. Without this strip, the NEXT
      // request's wire payload would carry the cancelled prompt as an
      // orphan user turn alongside the new one — model context would
      // contradict what the UI told the user was rewound. Mirrors the
      // existing strip in the Retry submit path
      // (GeminiClient.sendMessageStream).
      geminiClient?.stripOrphanedUserEntriesFromHistory?.();
      // Also undo the cross-session ↑-history disk entry written by
      // useGeminiStream's `logger.logMessage` — otherwise
      // getPreviousUserMessages would resurrect the cancelled prompt next
      // session. Fire-and-forget; the UI restore must not block on disk
      // I/O. Logger.removeLastUserMessage already swallows internal
      // errors and returns false, but attach a .catch as defence so a
      // future code path that throws doesn't surface as an
      // UnhandledPromiseRejection.
      void logger?.removeLastUserMessage().catch((err: unknown) => {
        debugLogger.debug('Failed to undo cancelled prompt from log:', err);
      });
    },
    [
      buffer,
      popAllMessages,
      historyManager,
      logger,
      geminiClient,
      refreshStatic,
      pendingSlashCommandHistoryItems,
      pendingGeminiHistoryItems,
    ],
  );

  const handleClearScreen = useCallback(() => {
    historyManager.clearItems();
    clearScreen();
    remountStaticHistory();
  }, [historyManager, remountStaticHistory]);

  const { handleInput: vimHandleInput } = useVim(buffer, handleFinalSubmit);

  /**
   * Determines if the input prompt should be active and accept user input.
   * Input is disabled during:
   * - Initialization errors
   * - Slash command processing
   * - Tool confirmations (WaitingForConfirmation state)
   * - Any future streaming states not explicitly allowed
   */
  const isInputActive =
    !initError &&
    !isProcessing &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding);

  const isFocused = useFocus();
  useBracketedPaste();

  useAwaySummary({
    enabled: settings.merged.general?.showSessionRecap ?? false,
    config,
    isFocused,
    isIdle: streamingState === StreamingState.Idle,
    addItem: historyManager.addItem,
    history: historyManager.history,
    awayThresholdMinutes:
      settings.merged.general?.sessionRecapAwayThresholdMinutes,
  });

  // Context file names computation
  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.context?.fileName;
    return fromSettings
      ? Array.isArray(fromSettings)
        ? fromSettings
        : [fromSettings]
      : getAllGeminiMdFilenames();
  }, [settings.merged.context?.fileName]);
  // Initial prompt handling
  const initialPrompt = useMemo(() => config.getQuestion(), [config]);
  const initialPromptSubmitted = useRef(false);

  useEffect(() => {
    if (
      initialPrompt &&
      isConfigInitialized &&
      !initialPromptSubmitted.current &&
      !isAuthenticating &&
      !isAuthDialogOpen &&
      !isThemeDialogOpen &&
      !isEditorDialogOpen &&
      !showWelcomeBackDialog &&
      welcomeBackChoice !== 'restart' &&
      geminiClient?.isInitialized?.()
    ) {
      handleFinalSubmit(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    isConfigInitialized,
    handleFinalSubmit,
    isAuthenticating,
    isAuthDialogOpen,
    isThemeDialogOpen,
    isEditorDialogOpen,
    showWelcomeBackDialog,
    welcomeBackChoice,
    geminiClient,
  ]);

  // Generate prompt suggestions when streaming completes. Enabled by default:
  // `mergeSettings` doesn't apply the schema `default: true`, so the runtime
  // gate must treat an unset value as enabled. Only an explicit `false` opts out.
  const followupSuggestionsEnabled =
    settings.merged.ui?.enableFollowupSuggestions !== false;

  useEffect(() => {
    // Clear suggestion when feature is disabled at runtime
    if (!followupSuggestionsEnabled) {
      suggestionAbortRef.current?.abort();
      setPromptSuggestion(null);
      if (speculationRef.current.status === 'running') {
        abortSpeculation(speculationRef.current).catch(() => {});
        speculationRef.current = IDLE_SPECULATION;
      }
    }

    // Clear suggestion and abort pending generation/speculation when a new turn starts
    if (
      prevStreamingStateRef.current === StreamingState.Idle &&
      streamingState === StreamingState.Responding
    ) {
      suggestionAbortRef.current?.abort();
      setPromptSuggestion(null);
      if (speculationRef.current.status !== 'idle') {
        abortSpeculation(speculationRef.current).catch(() => {});
        speculationRef.current = IDLE_SPECULATION;
      }
    }

    // Only trigger when transitioning from Responding to Idle (and enabled)
    // Skip when dialogs are active, in plan mode, elicitation pending, or last response was error
    if (
      followupSuggestionsEnabled &&
      config.isInteractive() &&
      !config.getSdkMode() &&
      prevStreamingStateRef.current === StreamingState.Responding &&
      streamingState === StreamingState.Idle &&
      // Check both committed history and pending items for errors
      // (API errors go to pendingGeminiHistoryItems, not historyManager.history)
      historyManager.history[historyManager.history.length - 1]?.type !==
        'error' &&
      !pendingGeminiHistoryItems.some((item) => item.type === 'error') &&
      !shellConfirmationRequest &&
      !confirmationRequest &&
      !loopDetectionConfirmationRequest &&
      !isPermissionsDialogOpen &&
      settingInputRequests.length === 0 &&
      config.getApprovalMode() !== ApprovalMode.PLAN
    ) {
      const ac = new AbortController();
      suggestionAbortRef.current = ac;

      // Only clone the tail — full structuredClone of a large resumed session
      // causes transient heap peaks that trigger OOM (#4624).
      const conversationHistory = geminiClient.getHistoryTail(40, true);
      generatePromptSuggestion(config, conversationHistory, ac.signal, {
        enableCacheSharing: settings.merged.ui?.enableCacheSharing === true,
      })
        .then((result) => {
          if (ac.signal.aborted) return;
          if (result.suggestion) {
            setPromptSuggestion(result.suggestion);
            // Start speculation if enabled (runs in background)
            if (settings.merged.ui?.enableSpeculation) {
              startSpeculation(config, result.suggestion, ac.signal)
                .then((state) => {
                  speculationRef.current = state;
                })
                .catch(() => {
                  // Speculation failure is non-blocking
                });
            }
          } else if (result.filterReason) {
            // Log suppressed suggestion for analytics
            logPromptSuggestion(
              config,
              new PromptSuggestionEvent({
                outcome: 'suppressed',
                reason: result.filterReason,
              }),
            );
          }
        })
        .catch(() => {
          // Silently degrade — don't disrupt the user experience
        });
    }

    // Only update prev ref when streamingState actually changes, so that
    // dialog-dependency re-runs don't cause us to miss a Responding→Idle transition.
    if (prevStreamingStateRef.current !== streamingState) {
      prevStreamingStateRef.current = streamingState;
    }

    return () => {
      suggestionAbortRef.current?.abort();
      // Cleanup speculation on unmount (#21)
      if (speculationRef.current.status !== 'idle') {
        abortSpeculation(speculationRef.current).catch(() => {});
        speculationRef.current = IDLE_SPECULATION;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guards may change independently
  }, [
    streamingState,
    followupSuggestionsEnabled,
    shellConfirmationRequest,
    confirmationRequest,
    loopDetectionConfirmationRequest,
    isPermissionsDialogOpen,
    settingInputRequests,
  ]);

  // Abort speculation when promptSuggestion is cleared (new turn or feature toggle).
  // promptSuggestion is only cleared when the model responds or the feature is disabled;
  // user typing/paste no longer dismisses it — the AbortController in InputPrompt handles
  // that path, so this effect only fires on state changes from non-user-input sources.
  useEffect(() => {
    if (!promptSuggestion && speculationRef.current.status !== 'idle') {
      abortSpeculation(speculationRef.current).catch(() => {});
      speculationRef.current = IDLE_SPECULATION;
    }
  }, [promptSuggestion]);

  const [idePromptAnswered, setIdePromptAnswered] = useState(false);
  const [currentIDE, setCurrentIDE] = useState<IdeInfo | null>(null);

  useEffect(() => {
    const getIde = async () => {
      const ideClient = await IdeClient.getInstance();
      const currentIde = ideClient.getCurrentIde();
      setCurrentIDE(currentIde || null);
    };
    getIde();
  }, []);
  const shouldShowIdePrompt = Boolean(
    currentIDE &&
      !config.getIdeMode() &&
      !settings.merged.ide?.hasSeenNudge &&
      !idePromptAnswered,
  );

  // Command migration nudge
  const {
    showMigrationNudge: shouldShowCommandMigrationNudge,
    tomlFiles: commandMigrationTomlFiles,
    setShowMigrationNudge: setShowCommandMigrationNudge,
  } = useCommandMigration(settings, config.storage);

  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);

  const [compactMode, setCompactMode] = useState<boolean>(
    settings.merged.ui?.compactMode ?? false,
  );
  const [compactInline] = useState<boolean>(
    settings.merged.ui?.compactInline ?? false,
  );
  const configuredRenderMode = settings.merged.ui?.renderMode;
  const [renderMode, setRenderMode] = useState<RenderMode>(
    configuredRenderMode === 'raw' ? 'raw' : 'render',
  );
  const renderModeConfigMountedRef = useRef(false);
  useEffect(() => {
    if (!renderModeConfigMountedRef.current) {
      renderModeConfigMountedRef.current = true;
      return;
    }

    setRenderMode(configuredRenderMode === 'raw' ? 'raw' : 'render');
  }, [configuredRenderMode]);
  const renderModeMountedRef = useRef(false);
  useEffect(() => {
    if (!renderModeMountedRef.current) {
      renderModeMountedRef.current = true;
      return;
    }

    refreshStatic();
  }, [renderMode, refreshStatic]);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [escapePressedOnce, setEscapePressedOnce] = useState(false);
  const escapeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const dialogsVisibleRef = useRef(false);
  const [isRewindSelectorOpen, setIsRewindSelectorOpen] = useState(false);
  const [rewindEscPending, setRewindEscPending] = useState(false);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [ideContextState, setIdeContextState] = useState<
    IdeContext | undefined
  >();
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [showIdeRestartPrompt, setShowIdeRestartPrompt] = useState(false);

  const { isFolderTrustDialogOpen, handleFolderTrustSelect, isRestarting } =
    useFolderTrust(settings, setIsTrustedFolder);
  const {
    isMcpApprovalDialogOpen,
    currentMcpApproval,
    pendingMcpApprovals,
    mcpApprovalRemaining,
    handleMcpApprovalSelect,
  } = useMcpApproval(config);
  const {
    needsRestart: ideNeedsRestart,
    restartReason: ideTrustRestartReason,
  } = useIdeTrustListener();
  const {
    isFeedbackDialogOpen,
    openFeedbackDialog,
    closeFeedbackDialog,
    temporaryCloseFeedbackDialog,
    submitFeedback,
  } = useFeedbackDialog({
    config,
    settings,
    streamingState,
    history: historyManager.history,
    sessionStats,
  });
  const dialogsVisible =
    showWelcomeBackDialog ||
    shouldShowIdePrompt ||
    shouldShowCommandMigrationNudge ||
    isFolderTrustDialogOpen ||
    isMcpApprovalDialogOpen ||
    !!shellConfirmationRequest ||
    !!confirmationRequest ||
    confirmUpdateExtensionRequests.length > 0 ||
    !!providerUpdateRequest ||
    settingInputRequests.length > 0 ||
    pluginChoiceRequests.length > 0 ||
    !!loopDetectionConfirmationRequest ||
    isThemeDialogOpen ||
    isSettingsDialogOpen ||
    isStatusLineDialogOpen ||
    isMemoryDialogOpen ||
    isModelDialogOpen ||
    isTrustDialogOpen ||
    activeArenaDialog !== null ||
    isPermissionsDialogOpen ||
    isAuthDialogOpen ||
    isAuthenticating ||
    isEditorDialogOpen ||
    showIdeRestartPrompt ||
    isSubagentCreateDialogOpen ||
    isAgentsManagerDialogOpen ||
    isSkillsManagerDialogOpen ||
    isMcpDialogOpen ||
    isHooksDialogOpen ||
    isStatsDialogOpen ||
    isApprovalModeDialogOpen ||
    isResumeDialogOpen ||
    isDeleteDialogOpen ||
    isHelpDialogOpen ||
    isExtensionsManagerDialogOpen ||
    isRewindSelectorOpen ||
    isDiffDialogOpen ||
    bgTasksDialogOpen ||
    showWorktreeExitDialog ||
    !!(settings.corruptedPath && !settings.corruptionDialogDismissed);
  dialogsVisibleRef.current = dialogsVisible;
  const shouldShowStickyTodos =
    stickyTodos !== null &&
    !dialogsVisible &&
    !isFeedbackDialogOpen &&
    streamingState !== StreamingState.WaitingForConfirmation;
  const stickyTodoWidth = Math.min(mainAreaWidth, 64);
  const stickyTodoMaxVisibleItems =
    getStickyTodoMaxVisibleItems(terminalHeight);
  const stickyTodosLayoutKey = shouldShowStickyTodos
    ? getStickyTodosLayoutKey(
        stickyTodos,
        stickyTodoWidth,
        stickyTodoMaxVisibleItems,
      )
    : 'hidden';
  const [controlsHeight, setControlsHeight] = useState(0);

  useLayoutEffect(() => {
    if (!mainControlsRef.current) {
      setControlsHeight((previousHeight) =>
        previousHeight === 0 ? previousHeight : 0,
      );
      return;
    }

    const fullFooterMeasurement = measureElement(mainControlsRef.current);
    setControlsHeight((previousHeight) =>
      previousHeight === fullFooterMeasurement.height
        ? previousHeight
        : fullFooterMeasurement.height,
    );
  }, [
    buffer,
    terminalWidth,
    terminalHeight,
    btwItem,
    dialogsVisible,
    stickyTodosLayoutKey,
  ]);

  // agentViewState is declared earlier (before handleFinalSubmit) so it
  // is available for input routing. Referenced here for layout computation.
  const tabBarHeight = agentViewState.agents.size > 0 ? 1 : 0;
  const availableTerminalHeight = Math.max(
    0,
    terminalHeight -
      controlsHeight -
      staticExtraHeight -
      MAIN_CONTENT_HEIGHT_RESERVATION -
      tabBarHeight,
  );

  config.setShellExecutionConfig({
    terminalWidth: Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
    terminalHeight: Math.max(
      Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING),
      1,
    ),
    pager: settings.merged.tools?.shell?.pager,
    showColor: settings.merged.tools?.shell?.showColor,
  });
  useEffect(() => {
    if (activePtyId) {
      ShellExecutionService.resizePty(
        activePtyId,
        Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
        Math.max(Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING), 1),
      );
    }
  }, [terminalWidth, availableTerminalHeight, activePtyId]);

  // Repaint static history on the trailing edge of a resize burst (#4891).
  useResizeSettleRepaint(terminalWidth, refreshStatic);

  useEffect(() => {
    if (ideNeedsRestart) {
      // IDE trust changed, force a restart.
      setShowIdeRestartPrompt(true);
    }
  }, [ideNeedsRestart]);

  useEffect(() => {
    const unsubscribe = ideContextStore.subscribe(setIdeContextState);
    setIdeContextState(ideContextStore.get());
    return unsubscribe;
  }, []);

  const handleEscapePromptChange = useCallback((showPrompt: boolean) => {
    setShowEscapePrompt(showPrompt);
  }, []);

  // --- Rewind selector callbacks ---
  // IDE guard here is NOT redundant with the keyboard handler guard (line ~2375):
  // /rewind calls openRewindSelector directly, bypassing the keyboard handler.
  const openRewindSelector = useCallback(() => {
    if (streamingState !== StreamingState.Idle) return;
    if (dialogsVisibleRef.current) return;
    if (config.getIdeMode()) {
      historyManager.addItem(
        {
          type: 'info',
          text: 'Rewind is disabled in IDE mode.',
        },
        Date.now(),
      );
      return;
    }
    const hasUserTurns = historyManager.history.some((h) => h.type === 'user');
    if (!hasUserTurns) return;
    setIsRewindSelectorOpen(true);
  }, [streamingState, config, historyManager]);
  openRewindSelectorRef.current = openRewindSelector;

  const closeRewindSelector = useCallback(() => {
    setIsRewindSelectorOpen(false);
  }, []);

  const handleRewindConfirm = useCallback(
    async (userItem: HistoryItem, option: RestoreOption) => {
      try {
        // For 'both', validate that conversation can be truncated BEFORE
        // touching files — otherwise we'd roll back the workspace while
        // the conversation stays at the newer state.
        const needsConversation =
          option === 'conversation' || option === 'both';
        const geminiClient = needsConversation
          ? config.getGeminiClient()
          : null;
        let apiTruncateIndex = -1;
        let conversationSkippedNoClient = false;
        if (needsConversation) {
          if (!geminiClient) {
            if (option === 'conversation') {
              historyManager.addItem(
                {
                  type: 'error',
                  text: t(
                    'Cannot rewind conversation: no active model client.',
                  ),
                },
                Date.now(),
              );
              return;
            }
            // 'both' with no client: skip conversation, still try files,
            // and surface a warning after the restore output.
            conversationSkippedNoClient = true;
          } else {
            apiTruncateIndex = computeApiTruncationIndex(
              historyManager.history,
              userItem.id,
              geminiClient.getHistoryShallow(),
            );
            if (apiTruncateIndex < 0) {
              historyManager.addItem(
                {
                  type: 'error',
                  text: t(
                    'Cannot rewind to a turn that was compressed. Try a more recent turn.',
                  ),
                },
                Date.now(),
              );
              if (option === 'both') {
                // Abort file restore too — don't create inconsistent state
                return;
              }
              return;
            }
          }
        }

        // Restore code (files on disk). For 'code'-only, don't truncate
        // the snapshot timeline — the conversation turns remain visible
        // and their snapshots must stay available for future rewinds.
        let fileRestoreMessage: string | undefined;
        let fileRestoreError: string | undefined;
        let hasRestoreFailure = false;
        if (option === 'code' || option === 'both') {
          const promptId = (userItem as HistoryItemUser).promptId;
          if (promptId) {
            try {
              const truncateHistory =
                option === 'both' && !!geminiClient && apiTruncateIndex >= 0;
              const result = await config
                .getFileHistoryService()
                .rewind(promptId, truncateHistory);
              if (result.filesChanged.length > 0) {
                fileRestoreMessage = t('Restored {{count}} file(s).', {
                  count: String(result.filesChanged.length),
                });
              } else if (result.filesFailed.length === 0) {
                fileRestoreMessage = t('No files needed to be restored.');
              }
              if (result.filesFailed.length > 0) {
                hasRestoreFailure = true;
                fileRestoreError = t(
                  'Failed to restore {{count}} file(s): {{files}}',
                  {
                    count: String(result.filesFailed.length),
                    files: result.filesFailed
                      .map((f) => f.split('/').pop())
                      .join(', '),
                  },
                );
              }
            } catch (error) {
              hasRestoreFailure = true;
              fileRestoreError = t('Failed to restore files: {{error}}', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            hasRestoreFailure = true;
            fileRestoreError = t(
              'Cannot restore files: this turn was created before file checkpointing was enabled.',
            );
          }
        }

        // Truncate conversation (already validated above).
        // Skip if file restore had failures in "both" mode to avoid inconsistent state.
        if (
          needsConversation &&
          geminiClient &&
          apiTruncateIndex >= 0 &&
          !(option === 'both' && hasRestoreFailure)
        ) {
          const originalHistory = historyManager.history;
          const hasSummary = originalHistory.some(
            (h) => h.display?.kind === 'collapse-summary',
          );
          const effectiveLength = hasSummary
            ? originalHistory.length - 1
            : originalHistory.length;

          let targetTurnIndex = 0;
          for (const h of originalHistory) {
            if (h.id === userItem.id) break;
            if (isRealUserTurn(h)) targetTurnIndex++;
          }

          geminiClient.truncateHistory(apiTruncateIndex);

          // Strip suppressOnRestore flags and filter out collapse-summary items
          // so rewound items remain visible without stale summary text
          const truncatedUi = expandCollapsedHistory(
            originalHistory.filter((h) => h.id < userItem.id),
          );
          historyManager.loadHistory(truncatedUi);

          refreshStatic();

          if (userItem.type === 'user' && userItem.text) {
            buffer.setText(userItem.text);
          }

          historyManager.addItem(
            {
              type: 'info',
              text: t(
                'Conversation rewound. Edit your prompt and press Enter to continue.',
              ),
            },
            Date.now(),
          );

          config.getChatRecordingService()?.rewindRecording(
            targetTurnIndex,
            { truncatedCount: effectiveLength - truncatedUi.length },
            !hasRestoreFailure
              ? config
                  .getFileHistoryService()
                  .getSnapshots()
                  .slice(0, targetTurnIndex + 1)
              : undefined,
          );
        }

        // Show file restore result after conversation truncation so the
        // message isn't immediately removed by loadHistory.
        if (fileRestoreMessage) {
          historyManager.addItem(
            { type: 'info', text: fileRestoreMessage },
            Date.now(),
          );
        }
        if (fileRestoreError) {
          historyManager.addItem(
            { type: 'error', text: fileRestoreError },
            Date.now(),
          );
        }
        if (conversationSkippedNoClient) {
          historyManager.addItem(
            {
              type: 'info',
              text: t(
                'Code restored, but conversation could not be rewound (no active client).',
              ),
            },
            Date.now(),
          );
        }
      } catch (error) {
        historyManager.addItem(
          {
            type: 'error',
            text: t('Rewind failed: {{error}}', {
              error: error instanceof Error ? error.message : String(error),
            }),
          },
          Date.now(),
        );
      } finally {
        setIsRewindSelectorOpen(false);
      }
    },
    [config, historyManager, refreshStatic, buffer],
  );

  const handleDoubleEscRewind = useDoublePress(openRewindSelector, (pending) =>
    setRewindEscPending(pending),
  );

  const handleIdePromptComplete = useCallback(
    (result: IdeIntegrationNudgeResult) => {
      if (result.userSelection === 'yes') {
        // Check whether the extension has been pre-installed
        if (result.isExtensionPreInstalled) {
          handleSlashCommand('/ide enable');
        } else {
          handleSlashCommand('/ide install');
        }
        settings.setValue(SettingScope.User, 'ide.hasSeenNudge', true);
      } else if (result.userSelection === 'dismiss') {
        settings.setValue(SettingScope.User, 'ide.hasSeenNudge', true);
      }
      setIdePromptAnswered(true);
    },
    [handleSlashCommand, settings],
  );

  const handleCommandMigrationComplete = useCallback(
    async (result: CommandMigrationNudgeResult) => {
      setShowCommandMigrationNudge(false);

      if (result.userSelection === 'yes') {
        // Perform migration for both workspace and user levels
        try {
          const results = [];

          // Migrate workspace commands
          const workspaceCommandsDir = config.storage.getProjectCommandsDir();
          const workspaceResult = await migrateTomlCommands({
            commandDir: workspaceCommandsDir,
            createBackup: true,
            deleteOriginal: false,
          });
          if (
            workspaceResult.convertedFiles.length > 0 ||
            workspaceResult.failedFiles.length > 0
          ) {
            results.push({ level: 'workspace', result: workspaceResult });
          }

          // Migrate user commands
          const userCommandsDir = Storage.getUserCommandsDir();
          const userResult = await migrateTomlCommands({
            commandDir: userCommandsDir,
            createBackup: true,
            deleteOriginal: false,
          });
          if (
            userResult.convertedFiles.length > 0 ||
            userResult.failedFiles.length > 0
          ) {
            results.push({ level: 'user', result: userResult });
          }

          // Report results
          for (const { level, result: migrationResult } of results) {
            if (
              migrationResult.success &&
              migrationResult.convertedFiles.length > 0
            ) {
              historyManager.addItem(
                {
                  type: MessageType.INFO,
                  text: `[${level}] Successfully migrated ${migrationResult.convertedFiles.length} command file${migrationResult.convertedFiles.length > 1 ? 's' : ''} to Markdown format. Original files backed up as .toml.backup`,
                },
                Date.now(),
              );
            }

            if (migrationResult.failedFiles.length > 0) {
              historyManager.addItem(
                {
                  type: MessageType.ERROR,
                  text: `[${level}] Failed to migrate ${migrationResult.failedFiles.length} file${migrationResult.failedFiles.length > 1 ? 's' : ''}:\n${migrationResult.failedFiles.map((f) => `  • ${f.file}: ${f.error}`).join('\n')}`,
                },
                Date.now(),
              );
            }
          }

          if (results.length === 0) {
            historyManager.addItem(
              {
                type: MessageType.INFO,
                text: 'No TOML files found to migrate.',
              },
              Date.now(),
            );
          }
        } catch (error) {
          historyManager.addItem(
            {
              type: MessageType.ERROR,
              text: `❌ Migration failed: ${getErrorMessage(error)}`,
            },
            Date.now(),
          );
        }
      }
    },
    [historyManager, setShowCommandMigrationNudge, config.storage],
  );

  const responseCandidateTokens = getResponseCandidateTokens(
    pendingGeminiHistoryItems,
  );

  const {
    elapsedTime,
    currentLoadingPhrase,
    taskStartTokens,
    taskStartStreamingChars,
  } = useLoadingIndicator(
    streamingState,
    settings.merged.ui?.customWittyPhrases,
    responseCandidateTokens,
    streamingResponseLengthRef.current,
  );

  useAttentionNotifications({
    isFocused,
    streamingState,
    elapsedTime,
    settings,
    config,
    terminal,
    pendingToolCalls,
  });

  // P-notif: terminal-bell when a workflow run finishes (completed / failed),
  // so a long run ending is noticed without watching the /workflows dialog.
  // User-initiated cancels are intentionally not notified (the registry omits
  // them). Separate from the dialog's status-change subscription.
  const workflowBellEnabled =
    (settings.merged.general?.terminalBell as boolean) ?? true;
  useEffect(() => {
    const registry = config.getWorkflowRunRegistry?.();
    // Optional call: production always has `setNotificationCallback`, but
    // partial registry mocks in CLI tests may omit it — no-op rather than throw.
    if (!registry?.setNotificationCallback) return;
    registry.setNotificationCallback((entry) => {
      const name = entry.meta?.name ?? entry.runId;
      const verb = entry.status === 'failed' ? 'failed' : 'completed';
      sendNotification(
        { message: `Workflow '${name}' ${verb}`, title: 'Qwen Code' },
        terminal,
        workflowBellEnabled,
      );
    });
    return () => registry.setNotificationCallback(undefined);
  }, [config, terminal, workflowBellEnabled]);

  // Dialog close functionality
  const { closeAnyOpenDialog } = useDialogClose({
    isThemeDialogOpen,
    handleThemeSelect,
    isApprovalModeDialogOpen,
    handleApprovalModeSelect,
    isAuthDialogOpen,
    closeAuthDialog,
    pendingAuthType,
    isEditorDialogOpen,
    exitEditorDialog,
    isSettingsDialogOpen,
    closeSettingsDialog,
    isStatusLineDialogOpen,
    closeStatusLineDialog,
    isMemoryDialogOpen,
    closeMemoryDialog,
    activeArenaDialog,
    closeArenaDialog,
    isFolderTrustDialogOpen,
    showWelcomeBackDialog,
    handleWelcomeBackClose,
    isHelpDialogOpen,
    closeHelpDialog,
    isBackgroundTasksDialogOpen: bgTasksDialogOpen,
    closeBackgroundTasksDialog: closeBgTasksDialog,
    isDiffDialogOpen,
    closeDiffDialog,
    isStatsDialogOpen,
    closeStatsDialog,
    showWorktreeExitDialog,
    closeWorktreeExitDialog: () => setShowWorktreeExitDialog(false),
  });

  const handleExit = useCallback(
    (
      pressedOnce: boolean,
      setPressedOnce: (value: boolean) => void,
      timerRef: React.MutableRefObject<NodeJS.Timeout | null>,
    ) => {
      // Fast double-press: Direct quit (preserve user habit) — unless the
      // session is inside an active worktree, in which case intercept and
      // show WorktreeExitDialog so the user explicitly decides keep vs
      // remove before the process exits.
      if (pressedOnce) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        if (activeWorktree) {
          setShowWorktreeExitDialog(true);
          setPressedOnce(false);
          return;
        }
        // Exit directly
        handleSlashCommand('/quit');
        return;
      }

      // First press: Prioritize cleanup tasks

      // 1. Close other dialogs (highest priority)
      /**
       * For AuthDialog it is required to complete the authentication process,
       * otherwise user cannot proceed to the next step.
       * So a quit on AuthDialog should go with normal two press quit.
       */
      if (isAuthDialogOpen) {
        setPressedOnce(true);
        timerRef.current = setTimeout(() => {
          setPressedOnce(false);
        }, 500);
        return;
      }

      // 2. Close other dialogs (highest priority)
      if (closeAnyOpenDialog()) {
        return; // Dialog closed, end processing
      }

      // 3. Cancel in-flight btw side-question
      if (btwItem && btwItem.btw.isPending && !dialogsVisibleRef.current) {
        cancelBtw();
        return; // Btw cancelled, end processing
      }

      // 4. Cancel ongoing requests
      if (streamingState === StreamingState.Responding) {
        cancelOngoingRequest?.();
        return; // Request cancelled, end processing
      }

      // 5. Clear input buffer (if has content)
      if (buffer.text.length > 0) {
        buffer.setText('');
        return; // Input cleared, end processing
      }

      // All cleanup tasks completed, set flag for double-press to quit
      setPressedOnce(true);
      timerRef.current = setTimeout(() => {
        setPressedOnce(false);
      }, CTRL_EXIT_PROMPT_DURATION_MS);
    },
    [
      isAuthDialogOpen,
      handleSlashCommand,
      closeAnyOpenDialog,
      btwItem,
      cancelBtw,
      streamingState,
      cancelOngoingRequest,
      buffer,
      activeWorktree,
    ],
  );

  const handleGlobalKeypress = useCallback(
    (key: Key) => {
      // Debug log keystrokes if enabled
      if (settings.merged.general?.debugKeystrokeLogging) {
        debugLogger.debug('[DEBUG] Keystroke:', JSON.stringify(key));
      }

      // ThinkingViewer owns all input while open.
      // Ctrl+C / Ctrl+D close the viewer and fall through to quit/exit.
      if (thinkingViewerData) {
        if (keyMatchers[Command.QUIT](key) || keyMatchers[Command.EXIT](key)) {
          closeThinkingViewer();
        } else {
          return;
        }
      }

      // Alt+T: toggle inline expansion of thinking blocks.
      if (keyMatchers[Command.TOGGLE_THINKING_EXPANDED](key)) {
        setThoughtExpanded((prev) => !prev);
        refreshStatic();
        return;
      }

      if (keyMatchers[Command.QUIT](key)) {
        if (isAuthenticating) {
          return;
        }

        // On first press: set flag, start timer, and call handleExit for cleanup
        // On second press (within timeout): handleExit sees flag and does fast quit
        if (!ctrlCPressedOnce) {
          setCtrlCPressedOnce(true);
          ctrlCTimerRef.current = setTimeout(() => {
            setCtrlCPressedOnce(false);
            ctrlCTimerRef.current = null;
          }, CTRL_EXIT_PROMPT_DURATION_MS);
        }

        handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
        return;
      } else if (keyMatchers[Command.EXIT](key)) {
        // Cancel in-flight btw even when buffer has text (Ctrl+D)
        if (btwItem && btwItem.btw.isPending && !dialogsVisibleRef.current) {
          cancelBtw();
          return;
        }
        if (buffer.text.length > 0) {
          return;
        }
        handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
        return;
      } else if (keyMatchers[Command.ESCAPE](key)) {
        // In vim INSERT mode, let vim's own handler (in InputPrompt) consume
        // the Esc to switch to NORMAL mode. Without this guard, both handlers
        // fire on the same keypress — vim switches mode AND AppContainer
        // shows "Press Esc again to clear" or cancels the stream.
        if (vimEnabled && vimMode === 'INSERT') {
          return;
        }

        // Dismiss or cancel btw side-question on Escape,
        // but only when btw is actually visible (not hidden behind a dialog).
        if (btwItem && !dialogsVisibleRef.current) {
          cancelBtw();
          return;
        }

        // Skip if shell is focused (to allow shell's own escape handling)
        if (embeddedShellFocused) {
          return;
        }

        // If input has content, use double-press to clear
        if (buffer.text.length > 0) {
          if (escapePressedOnce) {
            // Second press: clear input, keep the flag to allow immediate cancel
            buffer.setText('');
            return;
          }
          // First press: set flag and show prompt
          setEscapePressedOnce(true);
          escapeTimerRef.current = setTimeout(() => {
            setEscapePressedOnce(false);
            escapeTimerRef.current = null;
          }, CTRL_EXIT_PROMPT_DURATION_MS);
          return;
        }

        // Input is empty, cancel request immediately (no double-press needed)
        // Skip when a dialog (background tasks, etc.) is open — ESC should
        // close the dialog, not cancel the running request.
        if (
          streamingState === StreamingState.Responding &&
          !dialogsVisibleRef.current
        ) {
          if (escapeTimerRef.current) {
            clearTimeout(escapeTimerRef.current);
            escapeTimerRef.current = null;
          }
          cancelOngoingRequest?.();
          setEscapePressedOnce(false);
          return;
        }

        // Input is empty and idle — double-ESC opens rewind selector
        if (
          streamingState === StreamingState.Idle &&
          !dialogsVisibleRef.current &&
          !config.getIdeMode()
        ) {
          if (escapeTimerRef.current) {
            clearTimeout(escapeTimerRef.current);
            escapeTimerRef.current = null;
          }
          setEscapePressedOnce(false);
          handleDoubleEscRewind();
          return;
        }

        // No action available, reset the flag
        if (escapeTimerRef.current) {
          clearTimeout(escapeTimerRef.current);
          escapeTimerRef.current = null;
        }
        setEscapePressedOnce(false);
        return;
      }

      // Dismiss completed btw side-question on Space or Enter,
      // but only when btw is visible and the input buffer is empty.
      if (
        btwItem &&
        !btwItem.btw.isPending &&
        !dialogsVisibleRef.current &&
        buffer.text.length === 0
      ) {
        if (key.name === 'return' || key.sequence === ' ') {
          setBtwItem(null);
          return;
        }
      }

      // Note: Ctrl+C/D btw cancellation is handled inside handleExit
      // (step 3), not here, because Command.QUIT/EXIT match first.

      let enteringConstrainHeightMode = false;
      if (!constrainHeight) {
        enteringConstrainHeightMode = true;
        setConstrainHeight(true);
      }

      if (handleRenderModeToggleKey(key, setRenderMode)) {
        return;
      } else if (keyMatchers[Command.TOGGLE_TOOL_DESCRIPTIONS](key)) {
        const newValue = !showToolDescriptions;
        setShowToolDescriptions(newValue);

        const mcpServers = config.getMcpServers();
        if (Object.keys(mcpServers || {}).length > 0) {
          handleSlashCommand(newValue ? '/mcp desc' : '/mcp nodesc');
        }
      } else if (
        keyMatchers[Command.TOGGLE_IDE_CONTEXT_DETAIL](key) &&
        config.getIdeMode() &&
        ideContextState
      ) {
        handleSlashCommand('/ide status');
      } else if (
        keyMatchers[Command.SHOW_MORE_LINES](key) &&
        !enteringConstrainHeightMode
      ) {
        setConstrainHeight(false);
      } else if (keyMatchers[Command.TOGGLE_SHELL_INPUT_FOCUS](key)) {
        if (activePtyId || embeddedShellFocused) {
          setEmbeddedShellFocused((prev) => !prev);
        }
      } else if (keyMatchers[Command.TOGGLE_COMPACT_MODE](key)) {
        const newValue = !compactMode;
        setCompactMode(newValue);
        void settings.setValue(SettingScope.User, 'ui.compactMode', newValue);
        // Skip the expensive clearTerminal + Static remount when no past
        // item would render differently (no tool_group / gemini_thought*).
        // Future items pick up the new mode naturally because Static is
        // append-only. Issue #3899: this unfreezes Ctrl+O for plain-chat
        // long sessions; tool/thinking-bearing sessions still go through
        // the (now chunked) full path in MainContent.
        if (compactToggleHasVisualEffect(historyRef.current)) {
          refreshStatic();
        }
      } else if (keyMatchers[Command.PROMOTE_SHELL_TO_BACKGROUND](key)) {
        // Ctrl+B: promote a running foreground shell command to a
        // background task (#3831). The child keeps running, the
        // agent's turn unblocks, and the shell becomes a regular
        // BackgroundShellEntry visible in `/tasks` + the dialog and
        // stoppable via `task_stop`.
        //
        // Read from the ref (NOT the destructured `pendingToolCalls`)
        // so we don't have to put `pendingToolCalls` in the deps
        // array — that would re-bind the keypress handler on every
        // tool-call status update, which is noisy.
        //
        // No-op when no foreground shell is currently executing OR
        // the executing tool call is non-shell (no
        // `promoteAbortController` projected). Falling through in
        // the no-op case is intentional: while the agent is idle the
        // input layer's own Ctrl+B handler (cursor-left in the
        // prompt) should still fire as before.
        //
        // Broadcast caveat: `KeypressContext.broadcast()` has no
        // consumed-flag mechanism today, so even after we `return`
        // here the same Ctrl+B keypress is also dispatched to other
        // useKeypress consumers (text buffer cursor-left,
        // DebugProfiler, etc.). Visible side effect during a
        // successful promote: the input cursor will move one
        // character left if the prompt has focus. Cosmetic; tracked
        // for a follow-up that introduces a `consumed` return value
        // on KeypressHandler so global handlers can swallow keys.
        const executingShell = pendingToolCallsRef.current.find(
          (tc) =>
            tc.status === 'executing' &&
            // Defense-in-depth: also gate on the tool name. Today only
            // the shell tool's invocation wires `promoteAbortController`,
            // but a future copy-paste / type-confusion that adds the
            // property to a non-shell tool would otherwise let Ctrl+B
            // mistakenly fire `abort({kind:'background'})` on a tool
            // whose service has no promote-handoff handler.
            tc.request.name === ToolNames.SHELL &&
            tc.promoteAbortController !== undefined,
        ) as TrackedExecutingToolCall | undefined;
        if (executingShell?.promoteAbortController) {
          debugLogger.debug(
            `Ctrl+B promote: matched executing shell tool call ${executingShell.request.callId}`,
          );
          executingShell.promoteAbortController.abort({
            kind: 'background',
          });
          return;
        }
        debugLogger.debug(
          `Ctrl+B promote: no executing shell tool call; falling through ` +
            `(streamingState=${streamingState}, ` +
            `pendingToolCalls=${pendingToolCallsRef.current.length})`,
        );
      }
    },
    [
      constrainHeight,
      setConstrainHeight,
      showToolDescriptions,
      setShowToolDescriptions,
      config,
      ideContextState,
      handleExit,
      ctrlCPressedOnce,
      setCtrlCPressedOnce,
      ctrlCTimerRef,
      ctrlDPressedOnce,
      setCtrlDPressedOnce,
      ctrlDTimerRef,
      escapePressedOnce,
      setEscapePressedOnce,
      escapeTimerRef,
      streamingState,
      cancelOngoingRequest,
      buffer,
      handleSlashCommand,
      activePtyId,
      embeddedShellFocused,
      btwItem,
      setBtwItem,
      cancelBtw,
      // `settings` is a stable LoadedSettings instance (not recreated on render).
      // ESLint requires it here because the callback calls settings.setValue().
      // debugKeystrokeLogging is read at call time, so no stale closure risk.
      settings,
      isAuthenticating,
      compactMode,
      setCompactMode,
      setRenderMode,
      refreshStatic,
      handleDoubleEscRewind,
      vimEnabled,
      vimMode,
      thinkingViewerData,
      closeThinkingViewer,
      setThoughtExpanded,
    ],
  );

  useKeypress(handleGlobalKeypress, { isActive: true });

  // Update terminal title with the session name, or a fallback derived
  // from CLI_TITLE, the project folder, or the app default.
  // showStatusInTitle gates whether dynamic title updates happen at all;
  // it is kept for backward compatibility and future status-flag support.
  useEffect(() => {
    if (settings.merged.ui?.hideWindowTitle) {
      return;
    }

    if (settings.merged.ui?.showStatusInTitle === false) {
      if (lastTitleRef.current !== null) {
        lastTitleRef.current = null;
        const folderName = basename(config.getTargetDir());
        writeTerminalTitle(
          (value) => process.stdout.write(value),
          formatSessionWindowTitle(null, folderName),
        );
      }
      return;
    }

    const folderName = basename(config.getTargetDir());
    const title = formatSessionWindowTitle(sessionName, folderName);

    // Only update the title if it's different from the last value we set
    if (lastTitleRef.current !== title) {
      lastTitleRef.current = title;
      // Use process.stdout.write directly rather than Ink's proxied stdout
      // to avoid corruption of OSC escape sequences (see writeRaw comment at
      // line ~448 — Ink v6.2.3 proxies can mangle binary escape sequences).
      writeTerminalTitle((value) => process.stdout.write(value), title);
    }
    // Exit cleanup is handled by setWindowTitle() in gemini.tsx → process.on('exit')
  }, [
    sessionName,
    settings.merged.ui?.hideWindowTitle,
    settings.merged.ui?.showStatusInTitle,
    config,
  ]);

  // Drain queued messages when idle. `queueDrainNonce` re-fires the effect
  // after each submission settles so multi-step queues drain end-to-end.
  const queueDrainingRef = useRef(false);
  const [queueDrainNonce, setQueueDrainNonce] = useState(0);
  useEffect(() => {
    if (queueDrainingRef.current) return;
    if (!isConfigInitialized) return;
    if (streamingState !== StreamingState.Idle) return;
    if (dialogsVisible) return;
    if (messageQueue.length === 0) return;

    // Two-phase: batch plain prompts as one turn, else pop next slash command.
    const plainPrompts = drainQueue();
    const submission =
      plainPrompts.length > 0 ? plainPrompts.join('\n\n') : popNextSegment();
    if (submission === null) return;

    queueDrainingRef.current = true;
    Promise.resolve(submitQuery(submission)).finally(() => {
      queueDrainingRef.current = false;
      setQueueDrainNonce((n) => n + 1);
    });
  }, [
    isConfigInitialized,
    streamingState,
    dialogsVisible,
    messageQueue,
    drainQueue,
    popNextSegment,
    submitQuery,
    queueDrainNonce,
  ]);

  const nightly = props.version.includes('nightly');

  const uiState: UIState = useMemo(
    () => ({
      history: historyManager.history,
      historyManager,
      isThemeDialogOpen,
      themeError,
      auth: authState,
      isConfigInitialized,
      editorError,
      isEditorDialogOpen,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      isStatusLineDialogOpen,
      statusLineSettingsVersion,
      statusLineConfigOverride,
      isMemoryDialogOpen,
      isModelDialogOpen,
      isFastModelMode,
      isVoiceModelMode,
      isTrustDialogOpen,
      activeArenaDialog,
      isPermissionsDialogOpen,
      isApprovalModeDialogOpen,
      isResumeDialogOpen,
      resumeMatchedSessions,
      isDeleteDialogOpen,
      isHelpDialogOpen,
      activeHelpTab,
      slashCommands,
      recentSlashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      confirmUpdateExtensionRequests,
      providerUpdateRequest,
      settingInputRequests,
      pluginChoiceRequests,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      userMessages,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      shouldShowCommandMigrationNudge,
      commandMigrationTomlFiles,
      isFolderTrustDialogOpen: isFolderTrustDialogOpen ?? false,
      isMcpApprovalDialogOpen,
      currentMcpApproval,
      pendingMcpApprovals,
      mcpApprovalRemaining,
      isTrustedFolder,
      constrainHeight,
      ideContextState,
      showToolDescriptions,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      showAutoAcceptIndicator,
      currentModel,
      contextFileNames,
      availableTerminalHeight,
      useTerminalBuffer,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      pendingHistoryItems,
      stickyTodos,
      btwItem,
      setBtwItem,
      cancelBtw,
      nightly,
      branchName,
      activeWorktree,
      showWorktreeExitDialog,
      workflowKeywordActive,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      ideTrustRestartReason,
      isRestarting,
      extensionsUpdateState,
      activePtyId,
      embeddedShellFocused,
      // Welcome back dialog
      showWelcomeBackDialog,
      welcomeBackInfo,
      welcomeBackChoice,
      // Subagent dialogs
      isSubagentCreateDialogOpen,
      isAgentsManagerDialogOpen,
      // Skills manager dialog (`/skills`)
      isSkillsManagerDialogOpen,
      // Extensions manager dialog
      isExtensionsManagerDialogOpen,
      // MCP dialog
      isMcpDialogOpen,
      // Hooks dialog
      isHooksDialogOpen,
      isStatsDialogOpen,
      // Feedback dialog
      isFeedbackDialogOpen,
      // Per-task token tracking
      taskStartTokens,
      taskStartStreamingChars,
      responseCandidateTokens,
      // Real-time token display
      streamingResponseLengthRef,
      isReceivingContent,
      // Session name
      sessionName,
      setSessionName,
      // Prompt suggestion
      promptSuggestion,
      abortPromptSuggestion,
      // Rewind selector
      isRewindSelectorOpen,
      rewindEscPending,
      // Diff dialog
      isDiffDialogOpen,
    }),
    [
      isThemeDialogOpen,
      themeError,
      authState,
      isConfigInitialized,
      editorError,
      isEditorDialogOpen,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      isStatusLineDialogOpen,
      statusLineSettingsVersion,
      statusLineConfigOverride,
      isMemoryDialogOpen,
      isModelDialogOpen,
      isFastModelMode,
      isVoiceModelMode,
      isTrustDialogOpen,
      activeArenaDialog,
      isPermissionsDialogOpen,
      isApprovalModeDialogOpen,
      isResumeDialogOpen,
      resumeMatchedSessions,
      isDeleteDialogOpen,
      isHelpDialogOpen,
      activeHelpTab,
      slashCommands,
      recentSlashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      confirmUpdateExtensionRequests,
      providerUpdateRequest,
      settingInputRequests,
      pluginChoiceRequests,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      userMessages,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      shouldShowCommandMigrationNudge,
      commandMigrationTomlFiles,
      isFolderTrustDialogOpen,
      isMcpApprovalDialogOpen,
      currentMcpApproval,
      pendingMcpApprovals,
      mcpApprovalRemaining,
      isTrustedFolder,
      constrainHeight,
      ideContextState,
      showToolDescriptions,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      showAutoAcceptIndicator,
      contextFileNames,
      availableTerminalHeight,
      useTerminalBuffer,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      pendingHistoryItems,
      stickyTodos,
      btwItem,
      setBtwItem,
      cancelBtw,
      nightly,
      branchName,
      activeWorktree,
      showWorktreeExitDialog,
      workflowKeywordActive,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      ideTrustRestartReason,
      isRestarting,
      currentModel,
      extensionsUpdateState,
      activePtyId,
      historyManager,
      embeddedShellFocused,
      // Welcome back dialog
      showWelcomeBackDialog,
      welcomeBackInfo,
      welcomeBackChoice,
      // Subagent dialogs
      isSubagentCreateDialogOpen,
      isAgentsManagerDialogOpen,
      // Skills manager dialog (`/skills`)
      isSkillsManagerDialogOpen,
      // Extensions manager dialog
      isExtensionsManagerDialogOpen,
      // MCP dialog
      isMcpDialogOpen,
      // Hooks dialog
      isHooksDialogOpen,
      isStatsDialogOpen,
      // Feedback dialog
      isFeedbackDialogOpen,
      // Per-task token tracking
      taskStartTokens,
      taskStartStreamingChars,
      responseCandidateTokens,
      // Real-time token display
      streamingResponseLengthRef,
      isReceivingContent,
      // Session name
      sessionName,
      setSessionName,
      // Prompt suggestion
      promptSuggestion,
      abortPromptSuggestion,
      // Rewind selector
      isRewindSelectorOpen,
      rewindEscPending,
      // Diff dialog
      isDiffDialogOpen,
    ],
  );

  const uiActions: UIActions = useMemo(
    () => ({
      openThemeDialog,
      openEditorDialog,
      openMemoryDialog,
      handleThemeSelect,
      handleThemeHighlight,
      handleApprovalModeSelect,
      auth: authActions,
      handleEditorSelect,
      exitEditorDialog,
      closeSettingsDialog,
      closeStatusLineDialog,
      notifyStatusLineSettingsChanged,
      closeMemoryDialog,
      closeModelDialog,
      openModelDialog,
      openArenaDialog,
      closeArenaDialog,
      handleArenaModelsSelected,
      dismissProviderUpdate,
      closeTrustDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleCommandMigrationComplete,
      handleFolderTrustSelect,
      handleMcpApprovalSelect,
      setConstrainHeight,
      onEscapePromptChange: handleEscapePromptChange,
      onTabConsumerChange: setHasTabConsumer,
      refreshStatic,
      handleFinalSubmit,
      handleRetryLastPrompt: retryLastPrompt,
      handleClearScreen,
      popAllQueuedMessages: popAllMessages,
      // Welcome back dialog
      handleWelcomeBackSelection,
      handleWelcomeBackClose,
      // Worktree exit dialog
      handleWorktreeExit,
      // Subagent dialogs
      closeSubagentCreateDialog,
      closeAgentsManagerDialog,
      // Skills manager dialog (`/skills`)
      openSkillsManagerDialog,
      closeSkillsManagerDialog,
      reloadCommands,
      setInputBuffer: buffer.setText,
      // Extensions manager dialog
      closeExtensionsManagerDialog,
      // MCP dialog
      closeMcpDialog,
      // Hooks dialog
      openHooksDialog,
      // Hooks dialog
      closeHooksDialog,
      closeStatsDialog,
      // Resume session dialog
      openResumeDialog,
      closeResumeDialog,
      handleResume,
      // Branch (fork) session
      handleBranch,
      // Delete session dialog
      openDeleteDialog,
      closeDeleteDialog,
      handleDelete,
      handleDeleteMany,
      // Help dialog
      openHelpDialog,
      closeHelpDialog,
      setHelpTab,
      // Feedback dialog
      openFeedbackDialog,
      closeFeedbackDialog,
      temporaryCloseFeedbackDialog,
      submitFeedback,
      // Rewind selector
      openRewindSelector,
      closeRewindSelector,
      handleRewindConfirm,
      // Diff dialog
      openDiffDialog,
      closeDiffDialog,
    }),
    [
      openThemeDialog,
      openEditorDialog,
      openMemoryDialog,
      handleThemeSelect,
      handleThemeHighlight,
      handleApprovalModeSelect,
      authActions,
      handleEditorSelect,
      exitEditorDialog,
      closeSettingsDialog,
      closeStatusLineDialog,
      notifyStatusLineSettingsChanged,
      closeMemoryDialog,
      closeModelDialog,
      openModelDialog,
      openArenaDialog,
      closeArenaDialog,
      handleArenaModelsSelected,
      dismissProviderUpdate,
      closeTrustDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleCommandMigrationComplete,
      handleFolderTrustSelect,
      handleMcpApprovalSelect,
      setConstrainHeight,
      handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      retryLastPrompt,
      handleClearScreen,
      popAllMessages,
      handleWelcomeBackSelection,
      handleWelcomeBackClose,
      handleWorktreeExit,
      // Subagent dialogs
      closeSubagentCreateDialog,
      closeAgentsManagerDialog,
      // Skills manager dialog (`/skills`)
      openSkillsManagerDialog,
      closeSkillsManagerDialog,
      reloadCommands,
      buffer.setText,
      // Extensions manager dialog
      closeExtensionsManagerDialog,
      // MCP dialog
      closeMcpDialog,
      // Hooks dialog
      openHooksDialog,
      // Hooks dialog
      closeHooksDialog,
      closeStatsDialog,
      // Resume session dialog
      openResumeDialog,
      closeResumeDialog,
      handleResume,
      // Branch (fork) session
      handleBranch,
      // Delete session dialog
      openDeleteDialog,
      closeDeleteDialog,
      handleDelete,
      handleDeleteMany,
      // Help dialog
      openHelpDialog,
      closeHelpDialog,
      setHelpTab,
      // Feedback dialog
      openFeedbackDialog,
      closeFeedbackDialog,
      temporaryCloseFeedbackDialog,
      submitFeedback,
      // Rewind selector
      openRewindSelector,
      closeRewindSelector,
      handleRewindConfirm,
      // Diff dialog
      openDiffDialog,
      closeDiffDialog,
    ],
  );

  const compactModeValue = useMemo(
    () => ({ compactMode, compactInline, setCompactMode }),
    [compactMode, compactInline, setCompactMode],
  );
  const renderModeValue = useMemo(
    () => ({ renderMode, setRenderMode }),
    [renderMode, setRenderMode],
  );

  const thinkingViewerValue = useMemo(
    () => ({ openThinkingViewer }),
    [openThinkingViewer],
  );

  return (
    <UIStateContext.Provider value={uiState}>
      <UIActionsContext.Provider value={uiActions}>
        <ConfigContext.Provider value={config}>
          <AppContext.Provider
            value={{
              version: props.version,
              startupWarnings,
            }}
          >
            <CompactModeProvider value={compactModeValue}>
              <ThoughtExpandedProvider value={thoughtExpanded}>
                <RenderModeProvider value={renderModeValue}>
                  <TerminalOutputProvider value={writeRaw}>
                    <ThinkingViewerProvider value={thinkingViewerValue}>
                      <ShellFocusContext.Provider value={isFocused}>
                        {thinkingViewerData ? (
                          <ThinkingViewer
                            data={thinkingViewerData}
                            onClose={closeThinkingViewer}
                            useAlternateScreen={!useTerminalBuffer}
                          />
                        ) : (
                          <App />
                        )}
                      </ShellFocusContext.Provider>
                    </ThinkingViewerProvider>
                  </TerminalOutputProvider>
                </RenderModeProvider>
              </ThoughtExpandedProvider>
            </CompactModeProvider>
          </AppContext.Provider>
        </ConfigContext.Provider>
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};

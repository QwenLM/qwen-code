import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  DAEMON_APPROVAL_MODES,
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useSettings,
  useProviders,
  useSessionNotices,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptHistory,
  useTranscriptStore,
  useWorkspace,
  useWorkspaceActions,
  useWorkspaceEventSignals,
  type DaemonWorkspaceActions,
  type DaemonSessionNotice,
  type DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import { isDaemonTurnError } from '@qwen-code/sdk/daemon';
import type {
  DaemonInputAnnotation,
  DaemonTranscriptBlock,
  DaemonSessionTaskStatus,
  DaemonSessionArtifact,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import { GitForkIcon, XIcon } from 'lucide-react';
import { extractPendingPermission } from './adapters/transcriptAdapter';
import { MessageList, type MessageListHandle } from './components/MessageList';
import { extractVoiceModels, type VoiceModelOption } from './voice/voiceModels';
import {
  ChatEditor,
  type ComposerToolbarAction,
} from './components/ChatEditor';
import type {
  ComposerSubmitCommit,
  EditorHandle,
} from './hooks/useComposerCore';
import type { PromptImage } from './adapters/promptTypes';
import { StatusBar, type StatusBarHandle } from './components/StatusBar';
import { StreamingStatus } from './components/StreamingStatus';
import {
  ToastHost,
  type ToastTone,
  type WebShellToast,
} from './components/ToastHost';
import { TodoPanel } from './components/panels/TodoPanel';
import { WelcomeHeader } from './components/WelcomeHeader';
import { ApprovalModeDialog } from './components/dialogs/ApprovalModeDialog';
import { ResumeDialog } from './components/dialogs/ResumeDialog';
import { DialogShell } from './components/dialogs/DialogShell';
import {
  ModelDialog,
  type ModelDialogMode,
} from './components/dialogs/ModelDialog';
import { ModelFallbacksDialog } from './components/dialogs/ModelFallbacksDialog';
import {
  AgentsMessage,
  type AgentsInitialMode,
} from './components/messages/AgentsMessage';
import { MemoryMessage } from './components/messages/MemoryMessage';
import { AuthMessage } from './components/messages/AuthMessage';
import { ToolsDialog } from './components/dialogs/ToolsDialog';
import { GitDialog, type GitDialogView } from './components/dialogs/GitDialog';
import { SkillsManagerPage } from './components/skills/SkillsManagerPage';
import { DaemonStatusDialog } from './components/dialogs/DaemonStatusDialog';
import { SessionOverviewPanel } from './components/SessionOverviewPanel';
import { SplitView } from './components/SplitView';
import {
  ArtifactPanel,
  type ArtifactPanelTab,
} from './components/artifacts/ArtifactPanel';
import type {
  TurnOutputFileChange,
  TurnOutputKind,
  TurnOutputOpenRequest,
  TurnOutputScheduledTask,
} from './components/artifacts/TurnOutputs';
import { TURN_OUTPUT_KINDS } from './components/artifacts/TurnOutputs';
import {
  getArtifactsByTurn,
  getFileChangesByTurn,
  getScheduledTasksByTurn,
} from './components/artifacts/turnOutputSelectors';
import { useIsLargeScreen } from './hooks/useIsLargeScreen';
import {
  clearSplitSessions,
  loadSplitSessions,
  MAX_SPLIT_PANES,
  parseSplitSessionIds,
  saveSplitSessions,
} from './utils/splitUrl';
import { ScheduledTasksDialog } from './components/dialogs/ScheduledTasksDialog';
import { GoalsDialog } from './components/dialogs/GoalsDialog';
import {
  goalArgOf,
  isGoalClearCommand,
  isGoalClearKeyword,
} from './utils/goalCondition';
import { ExtensionsManagerPage } from './components/extensions/ExtensionsManagerPage';
import { PluginManagerPage } from './components/plugins/PluginManagerPage';
import { SettingsMessage } from './components/messages/SettingsMessage';
import { isAskUserPermission } from './utils/askUserPermission';
import { ToolApproval } from './components/messages/ToolApproval';
import { AskUserQuestion } from './components/messages/AskUserQuestion';
import { HelpDialog } from './components/dialogs/HelpDialog';
import { ThemeDialog } from './components/dialogs/ThemeDialog';
import { DeleteSessionDialog } from './components/dialogs/DeleteSessionDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { RewindDialog } from './components/dialogs/RewindDialog';
import {
  WebShellSidebar,
  type WebShellSidebarBranding,
  type WebShellSidebarFooterOptions,
  type WebShellSidebarLockedWorkspace,
} from './components/sidebar/WebShellSidebar';
import { isSidebarToggleShortcut } from './components/sidebar/sidebarToggleShortcut';
import { workspaceLabel } from './utils/workspace';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameValue } from './hooks/useAnimationFrameValue';
import { useBackgroundTasks } from './hooks/useBackgroundTasks';
import { useMessages } from './hooks/useMessages';
import { useSessionArtifacts } from './hooks/useSessionArtifacts';
import { useShallowMemo, useStableArray } from './hooks/useShallowMemo';
import {
  I18nProvider,
  getTranslator,
  languageSettingToWebShellLanguage,
  languageLabel,
  normalizeLanguage,
  type WebShellLanguage,
} from './i18n';
import {
  copyFromLastAssistantMessage,
  COPY_MESSAGES,
} from './utils/copyCommand';
import { isEditableTarget } from './utils/dom';
import {
  invokeSlashCommandHandler,
  SLASH_COMMAND_PATTERN,
} from './utils/slash-command-action';
import { getModelDisplayName } from './utils/modelDisplay';
import { isVisibleComposerModel } from './utils/composerModels';
import { filterModelSwitchMessages } from './utils/modelSwitchMessages';
import { decideEscapeIntent } from './utils/escapeIntent';
import type { SkillInfo } from './completions/slashCompletion';
import { collectSystemInfo } from './utils/systemInfo';
import {
  decodeVisionModelForPicker,
  encodeVisionModelForSetting,
  extractBareModelId,
} from './utils/modelEncoding';
import { appendOrDeferLocalUserMessage } from './utils/localCommandQueue';
import { QueuedPromptDisplay } from './components/QueuedPromptDisplay';
import { useQueuedPrompts } from './hooks/useQueuedPrompts';
import { useNewSessionSuggestion } from './hooks/useNewSessionSuggestion';
import {
  TasksStatusMessage,
  type SerializedTasksMessage,
} from './components/messages/TasksStatusMessage';
import { isBackgroundSubAgentToolCall } from './adapters/toolClassification';
import { serializeContextUsageMessage } from './components/messages/ContextUsageMessage';
import {
  serializeStatsMessage,
  type StatsView,
} from './components/messages/StatsMessage';
import {
  serializeStatusMessage,
  type StatusInfo,
} from './components/messages/StatusMessage';
import type { SerializedMcpStatusMessage } from './components/messages/McpStatusMessage';
import { McpManagerPage } from './components/mcp/McpManagerPage';
import {
  GOAL_STATUS_ACTIVE_EVENT,
  parseGoalStatusMessage,
  serializeGoalStatusMessage,
} from './components/messages/GoalStatusMessage';
import { BtwMessage } from './components/messages/BtwMessage';
import {
  createAndAttachSessionForPrompt,
  isDaemonApprovalMode,
} from './utils/sessionPreparation';
import {
  getComposerPlaceholderKey,
  getComposerPlaceholderState,
  shouldBlockComposerSubmit,
  shouldDisableComposerInput,
  type ComposerPlaceholderState,
} from './utils/composerInputState';
import type { ACPToolCall, Message, PermissionRequest } from './adapters/types';
import {
  computeTodoDetails,
  computeTodoTimeline,
  getFloatingTodos,
  todoDetailSignature,
  todoTimelineSignature,
  type TodoDetail,
  type TodoSnapshotDiff,
} from './utils/todos';
import { ThemeProvider } from './themeContext';
import { InteractionBlockContext } from './interactionBlockContext';
import {
  WebShellThemeId,
  THEME_SETTING_KEY,
  LANGUAGE_SETTING_KEY,
  themeSettingToWebShellTheme,
  webShellThemeToSettingValue,
  type WebShellTheme,
} from './themeContext';
import {
  WebShellCustomizationProvider,
  type WebShellComposerApi,
  type WebShellComposerInput,
  type WebShellMarkdownCustomization,
  type ToolHeaderExtraRenderer,
  type UserMessageContentRenderer,
  type UserMessageContentParser,
  type AssistantTurnFooterRenderer,
  type WelcomeHeaderRenderer,
  type WelcomeFooterRenderer,
  type ComposerToolbarStartRenderer,
  type ComposerToolbarEndRenderer,
  type ComposerToolbarRightRenderer,
  type ComposerHeaderRenderer,
  type FooterRenderer,
  type LoadingPhrasesResolver,
  type MarkdownTableMode,
  type WebShellTaskInfo,
  type WebShellAtProvider,
  type WebShellBuiltinAtProvidersConfig,
  type ComposerTagClickHandler,
  type ComposerTagRenderer,
  type WebShellComposerTagIconMap,
  type WebShellBottomStatusItem,
} from './customization';
import type { CommandDisplayCategoryOrder } from './utils/commandDisplay';
import { WebShellPortalRootContext } from './portalRoot';
import './styles/globals.css';
import styles from './App.module.css';

export const CompactModeContext = createContext(false);

/**
 * Per-snapshot status diffs (keyed by tool callId or plan message id), so a
 * history row can render what changed in that snapshot without re-deriving it
 * from the whole transcript. Empty by default so a row rendered outside the
 * provider still falls back gracefully.
 */
export const TodoTimelineContext = createContext<Map<string, TodoSnapshotDiff>>(
  new Map(),
);

/**
 * Per-todo timing and resource detail keyed by todoStateKey, consumed by the
 * expanded todo list so a finished task can reveal when it ran and what it
 * spent. Empty by default so a row rendered outside the provider (or in tests)
 * simply shows no expander.
 */
export const TodoDetailContext = createContext<Map<string, TodoDetail>>(
  new Map(),
);

/**
 * Provides both todo contexts in one wrapper so the message list stays at a
 * single nesting level (one provider in the tree, not two).
 */
function TodoContextsProvider({
  timeline,
  details,
  children,
}: {
  timeline: Map<string, TodoSnapshotDiff>;
  details: Map<string, TodoDetail>;
  children: ReactNode;
}) {
  return (
    <TodoTimelineContext.Provider value={timeline}>
      <TodoDetailContext.Provider value={details}>
        {children}
      </TodoDetailContext.Provider>
    </TodoTimelineContext.Provider>
  );
}

const MODES_CYCLE = DAEMON_APPROVAL_MODES;
const MAX_TOASTS = 4;
const DEFAULT_REVIEW_PANEL_WIDTH = 760;
const MIN_ARTIFACT_PANEL_WIDTH = 320;
const MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL = 500;
const MAX_ARTIFACT_PANEL_SESSION_STATES = 20;
interface ArtifactPanelSessionState {
  open: boolean;
  tabs: ArtifactPanelTab[];
  activeTabId: string | null;
  reviewChanges: readonly TurnOutputFileChange[];
  selectedReviewPath: string | null;
  extraArtifacts: DaemonSessionArtifact[];
  width: number;
}
interface PaneArtifactSnapshot {
  artifacts: readonly DaemonSessionArtifact[];
  workspaceActions: DaemonWorkspaceActions;
}
// Cap on how long a manual "run now" waits for its bound session to become
// active before giving up, so the scheduled-tasks UI can't stay stuck disabled
// if the switch never completes.
const BOUND_RUN_SWITCH_TIMEOUT_MS = 30_000;

function availableSkillInfos(status: {
  skills?: Array<{
    status?: string;
    name: string;
    description?: string;
    argumentHint?: string;
  }>;
}): SkillInfo[] {
  return (status.skills ?? [])
    .filter((skill) => skill.status === 'ok')
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const COMPACT_MODE_SETTING_KEY = 'ui.compactMode';
const HIDE_TIPS_SETTING_KEY = 'ui.hideTips';

/** Maps each ModelDialogMode to its i18n title key — single source of truth. */
const MODE_TITLE_KEY: Record<ModelDialogMode, string> = {
  main: 'model.select',
  fast: 'model.setFast',
  voice: 'model.setVoice',
  vision: 'model.setVision',
};

function normalizeHiddenCommand(command: string): string {
  return command.trim().replace(/^\/+/, '').toLowerCase();
}

interface ActiveGoalStatus {
  condition: string;
  setAt: number;
}

interface SendPromptOptionsWithRetry {
  optimisticUserMessage?: boolean;
  images?: PromptImage[];
  inputAnnotations?: DaemonInputAnnotation[];
  retry?: boolean;
  clearComposerOnPromptStart?: boolean;
  commitComposerAccepted?: ComposerSubmitCommit;
  onAdmitted?: () => void;
}

type GoalStatusTranscriptBlock = DaemonTranscriptBlock & {
  text: string;
  source?: string;
  data?: unknown;
};

function parseGoalStatusFromBlock(block: DaemonTranscriptBlock) {
  const statusBlock = block as GoalStatusTranscriptBlock;
  if (statusBlock.source !== 'goal') return null;
  return (
    parseGoalStatusMessage(statusBlock.data) ??
    parseGoalStatusMessage(statusBlock.text)
  );
}

function getLatestActiveGoalFromBlocks(
  blocks: readonly DaemonTranscriptBlock[],
): ActiveGoalStatus | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind !== 'status') continue;
    const status = parseGoalStatusFromBlock(block);
    if (!status) continue;
    if (status.kind === 'set' || status.kind === 'checking') {
      return {
        condition: status.condition,
        setAt: status.setAt ?? block.serverTimestamp ?? block.createdAt,
      };
    }
    return null;
  }
  return null;
}

interface LocalAnchoredMessage {
  anchorAfterId?: string;
  anchorIndex: number;
  message: Message;
}

interface ModelSwitchSummary {
  authType: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  isRuntime?: boolean;
}

export interface BugReportInfo {
  title: string;
  systemInfo: Record<string, string>;
}

export interface WebShellSidebarOptions {
  enabled?: boolean;
  defaultCollapsed?: boolean;
  /** Whether to show WebShell's built-in compact drawer toggle. Defaults to true. */
  showCompactToggle?: boolean;
  /** Hide or replace the complete sidebar branding row. */
  branding?: false | WebShellSidebarBranding;
  /** Hide the footer completely or select the built-in entries it exposes. */
  footer?: false | WebShellSidebarFooterOptions;
  /** Customize the workspace row shown when lockWorkspaceCwd is active. */
  lockedWorkspace?: WebShellSidebarLockedWorkspace;
}

export type SessionChangeEvent =
  | { type: 'rename'; sessionId: string; newName: string }
  | { type: 'submit'; sessionId: string; prompt: string; queued: boolean }
  | { type: 'turn_complete'; sessionId: string; error?: Error };

export interface WebShellApi {
  /** Open the in-window split view, matching the built-in sidebar button. */
  openSplitView: () => void;
  /** Open the Session Overview panel, matching the built-in sidebar button. */
  openSessionOverview: () => void;
  /** Open the compact session drawer, matching the hamburger control. */
  openSessionDrawer: () => void;
  /** Start a new session using the same lifecycle as the built-in New Chat action. */
  createNewSession: () => Promise<boolean>;
}

export type WebShellComposerPlaceholderState = ComposerPlaceholderState;

export type WebShellComposerPlaceholders = Readonly<
  Partial<Record<WebShellComposerPlaceholderState, string>>
>;

export interface WebShellSlashCommand {
  /** Slash command name without the leading slash, normalized to lower case. */
  command: string;
  /** Trimmed text following the command name. */
  args: string;
  /** Original text submitted from the composer. */
  input: string;
}

export type WebShellSlashCommandHandler = (
  command: WebShellSlashCommand,
) => boolean | void;

export interface WebShellProps {
  /** Called whenever the attached daemon session or workspace changes. */
  onSessionIdChange?: (
    sessionId: string | undefined,
    workspaceId?: string,
    workspaceCwd?: string,
  ) => void;
  /** Called after a new session is created. Session setup waits up to 30 seconds. */
  onSessionCreated?: (sessionId: string) => Promise<void> | void;
  /** Visual theme for the embedded shell. */
  theme?: WebShellTheme;
  /** Called when `/theme` changes the web-shell theme. */
  onThemeChange?: (theme: WebShellTheme) => void;
  /** UI language for the web-shell. Defaults to `?language=` or browser language. */
  language?: 'en' | 'zh-CN' | 'zh' | 'zh-cn';
  /** Called when `/language ui` changes the web-shell UI language. */
  onLanguageChange?: (language: WebShellLanguage) => void;
  /** Additional CSS class name appended to the root element. */
  className?: string;
  /** Inline styles applied to the root element. */
  style?: React.CSSProperties;
  /** Maximum chat content width in regular mode. Defaults to 1000px. */
  chatMaxWidth?: number;
  /** Optional workspace sidebar. Disabled by default. */
  sidebar?: boolean | WebShellSidebarOptions;
  /** Session ids to control the split view; an empty array closes it. */
  splitSessionIds?: readonly string[];
  /** Called when the split pane list changes from inside WebShell. */
  onSplitSessionIdsChange?: (sessionIds: string[]) => void;
  /**
   * Called instead of the built-in right panel open behavior when a user clicks
   * a turn output such as review changes, an artifact, or a scheduled task.
   */
  onRightPanelOpen?: (request: TurnOutputOpenRequest) => void;
  /**
   * Controls which turn output cards appear below messages. Defaults to all.
   */
  messageTurnOutputs?: readonly TurnOutputKind[];
  /** Imperative handle for externally opening WebShell surfaces. */
  shellRef?: React.Ref<WebShellApi>;
  /** Built-in composer toolbar actions to show. Defaults to all actions. */
  composerToolbarActions?: readonly ComposerToolbarAction[];
  /**
   * Main-composer copy by semantic state. Omitted or blank entries retain the
   * WebShell localized default; shell-mode and follow-up copy still wins.
   */
  composerPlaceholders?: WebShellComposerPlaceholders;
  /** Called when connection status changes (idle/connecting/connected/disconnected/error). */
  onConnectionChange?: (status: string) => void;
  /** Called when prompt status changes (idle/waiting/responding). */
  onStreamingStateChange?: (state: DaemonStreamingState) => void;
  /**
   * Called whenever transcript blocks change. Receives the full blocks array
   * from useTranscriptBlocks(). Fires on every streaming delta during active
   * generation, so consumers should debounce or throttle expensive work.
   */
  onTranscriptChange?: (blocks: readonly DaemonTranscriptBlock[]) => void;
  /** Called when a critical error occurs (auth failure, session gone, etc). */
  onError?: (error: Error) => void;
  /** Called when `/bug` is invoked. Receives system info. If omitted, web-shell opens the report URL itself. */
  onBugReport?: (info: BugReportInfo) => void;
  /** Slash command names to hide from completion/help, for example `['approval-mode']`. */
  hiddenSlashCommands?: string[];
  /** Slash command category order. Defaults to custom, skill, system. */
  slashCommandCategoryOrder?: CommandDisplayCategoryOrder;
  /**
   * Called before Web Shell handles a slash command. Return true to skip the
   * built-in or daemon behavior after handling the command in the host.
   */
  onSlashCommand?: WebShellSlashCommandHandler;
  /** Built-in @ mention providers to enable. Defaults to all built-ins. */
  builtinAtProviders?: WebShellBuiltinAtProvidersConfig;
  /** Additional @ mention categories shown alongside built-in files/extensions. */
  atProviders?: readonly WebShellAtProvider[];
  /** Icon URLs for custom composer tag kinds used by @ mention chips. */
  composerTagIcons?: WebShellComposerTagIconMap;
  /** Custom renderer for the tool-card header content after the status icon and tool name. */
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  /** Custom renderer for the welcome header. Receives version, cwd, model, and mode. */
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  /** Custom renderer shown below the chat composer in the empty welcome state. */
  renderWelcomeFooter?: WelcomeFooterRenderer;
  /**
   * Show renderWelcomeFooter between the welcome header and composer on
   * mobile empty state. Requires renderWelcomeFooter to be provided for the
   * mobile CSS reordering to take effect.
   */
  mobileWelcomeFooterMiddle?: boolean;
  /** Parse user-message text into display parts such as chips. */
  parseUserMessageContent?: UserMessageContentParser;
  /** Custom renderer for the inside of user chat bubbles. Defaults to plain text. */
  renderUserMessageContent?: UserMessageContentRenderer;
  /** Custom renderer for composer and user-message tags. */
  renderComposerTag?: ComposerTagRenderer;
  /** Custom hover content for composer and user-message tags. */
  renderComposerTagTooltip?: ComposerTagRenderer;
  /** Click handler for composer and user-message tags. */
  onComposerTagClick?: ComposerTagClickHandler;
  /** Custom renderer displayed after the final assistant message of each turn. */
  renderAssistantTurnFooter?: AssistantTurnFooterRenderer;
  /** Custom renderer inserted before the built-in chat composer toolbar controls. */
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  /** Custom renderer inserted after the built-in composer toolbar controls. */
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  /** Custom renderer inserted into the composer toolbar's right-side action area. */
  renderComposerToolbarRight?: ComposerToolbarRightRenderer;
  /** Custom renderer shown directly above the chat composer input. */
  renderComposerHeader?: ComposerHeaderRenderer;
  /** Custom component for the footer area below the Editor. Replaces the built-in StatusBar. */
  renderFooter?: FooterRenderer;
  /** Extra status items shown in the floating bottom panel beside the TODO summary. */
  bottomStatusItems?: readonly WebShellBottomStatusItem[];
  /** Collapse thinking blocks to 5 lines with a click-to-expand toggle. */
  compactThinking?: boolean;
  /** Auto-collapse completed turns to just the prompt and final answer, with a per-turn toggle. Defaults to true. */
  collapseCompletedTurns?: boolean;
  /** Markdown table rendering mode. Defaults to basic. */
  markdownTableMode?: MarkdownTableMode;
  /** Enable virtual scrolling only when rendered transcript rows exceed this threshold. Defaults to 200. */
  virtualScrollThreshold?: number;
  /** Custom Markdown behavior for assistant content only. */
  markdown?: WebShellMarkdownCustomization;
  /**
   * Override the witty phrases cycled while a prompt is streaming. Receives the
   * resolved UI language; return phrases to replace the built-in defaults, an
   * empty array to hide the phrase, or `undefined`/`null` to keep the defaults.
   */
  loadingPhrases?: LoadingPhrasesResolver;
  /** When provided, all toast notifications are forwarded to this callback and the built-in ToastHost is hidden. */
  onToast?: (tone: ToastTone, message: string) => void;
  /** Imperative handle for externally controlling the composer input. */
  composerRef?: React.Ref<WebShellComposerApi>;
  /** Called once the real composer API is mounted and safe to call. */
  onComposerReady?: (api: WebShellComposerApi) => void;
  /** Declarative composer input value. Increment composerInputVersion to replay the same value. */
  composerInput?: WebShellComposerInput;
  /** Replay key for composerInput. */
  composerInputVersion?: number;
  /** Called when a session-level event occurs (rename, submit, turn complete). */
  onSessionChange?: (event: SessionChangeEvent) => void;
  /**
   * Called before a prompt is submitted. Return a Promise — the prompt is held
   * until the Promise resolves. If the Promise rejects, the prompt is cancelled.
   * `sessionId` is `undefined` when the session has not yet been created (deferred).
   * Also called for queued prompts (submitted while a turn is streaming).
   */
  onSubmitBefore?: (params: {
    sessionId: string | undefined;
    prompt: string;
  }) => Promise<void>;
}

interface AppProps extends WebShellProps {
  lockedWorkspaceCwd?: string;
  lockedWorkspaceCapability?: DaemonWorkspaceCapability;
  restartSseOnPrompt?: boolean;
}

type SessionActionsWithCreate = {
  createSession: (options?: {
    workspaceCwd?: string;
    approvalMode?: string;
    sourceType?: string;
    worktree?: { slug?: string };
  }) => Promise<{
    sessionId: string;
    worktree?: { slug: string; path: string; branch: string };
  }>;
  attachSession: () => Promise<void>;
  clearSession: () => Promise<void>;
  releaseSession: (sessionId: string) => Promise<void>;
};

const emptyComposerApi: WebShellComposerApi = {
  insertText: () => {},
  setText: () => {},
  addTags: () => {},
  removeTag: () => {},
  clear: () => {},
  submit: () => {},
};

const EMPTY_BOTTOM_STATUS_ITEMS: readonly WebShellBottomStatusItem[] = [];
const DEFAULT_CHAT_MAX_WIDTH = 1000;
const BOTTOM_PANEL_GAP_PX = 6;
const BOTTOM_PANEL_FALLBACK_INSET_PX = 40;
type ChatWidthMode = `${typeof DEFAULT_CHAT_MAX_WIDTH}` | 'wide';

const CHAT_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-chat-width';
const CHAT_SHELL_HORIZONTAL_PADDING = 40;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'qwen-code-web-shell-sidebar-collapsed';

function resolveSidebarOptions(sidebar: WebShellProps['sidebar']): {
  enabled: boolean;
  defaultCollapsed: boolean;
  showCompactToggle: boolean;
  branding?: false | WebShellSidebarBranding;
  footer?: false | WebShellSidebarFooterOptions;
  lockedWorkspace?: WebShellSidebarLockedWorkspace;
} {
  if (sidebar === true) {
    return { enabled: true, defaultCollapsed: false, showCompactToggle: true };
  }
  if (!sidebar) {
    return { enabled: false, defaultCollapsed: false, showCompactToggle: true };
  }
  return {
    enabled: sidebar.enabled ?? true,
    defaultCollapsed: sidebar.defaultCollapsed ?? false,
    showCompactToggle: sidebar.showCompactToggle ?? true,
    branding: sidebar.branding,
    footer: sidebar.footer,
    lockedWorkspace: sidebar.lockedWorkspace,
  };
}

function readSidebarCollapsed(defaultCollapsed: boolean): boolean {
  if (typeof window === 'undefined') return defaultCollapsed;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
  return defaultCollapsed;
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      String(collapsed),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function getDefaultChatWidthMode(): ChatWidthMode {
  return `${DEFAULT_CHAT_MAX_WIDTH}`;
}

function readChatWidthMode(): ChatWidthMode {
  if (typeof window === 'undefined') return getDefaultChatWidthMode();
  try {
    return window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY) === 'wide'
      ? 'wide'
      : getDefaultChatWidthMode();
  } catch {
    return getDefaultChatWidthMode();
  }
}

function writeChatWidthMode(mode: ChatWidthMode): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, mode);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function getChatMaxWidth(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_CHAT_MAX_WIDTH;
}

function getChatWidthStyle(
  mode: ChatWidthMode,
  chatMaxWidth: number | undefined,
): CSSProperties {
  const contentWidth = `${getChatMaxWidth(chatMaxWidth)}px`;
  const shellWidth = `calc(${contentWidth} + ${CHAT_SHELL_HORIZONTAL_PADDING}px)`;
  return {
    '--chat-regular-content-width': contentWidth,
    '--chat-regular-shell-width': shellWidth,
    '--chat-content-width': mode === 'wide' ? '100%' : contentWidth,
    '--chat-shell-width': mode === 'wide' ? '100%' : shellWidth,
  } as CSSProperties;
}

function assignComposerRef(
  ref: React.Ref<WebShellComposerApi> | undefined,
  value: WebShellComposerApi,
): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<WebShellComposerApi | null>).current = value;
}

function assignShellRef(
  ref: React.Ref<WebShellApi> | undefined,
  value: WebShellApi | null,
): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as React.MutableRefObject<WebShellApi | null>).current = value;
}

function areSessionIdsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function getInitialLanguage(): WebShellLanguage {
  if (typeof window === 'undefined') return 'en';
  const params = new URLSearchParams(window.location.search);
  return normalizeLanguage(
    params.get('language') ?? params.get('lang') ?? navigator.language,
  );
}

function formatError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

interface AlreadyDispatchedError extends Error {
  _alreadyDispatched: true;
}

function isAlreadyDispatched(error: unknown): error is AlreadyDispatchedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as AlreadyDispatchedError)._alreadyDispatched === true
  );
}

function shouldToastNotice(notice: DaemonSessionNotice): boolean {
  return (
    notice.category === 'validation' ||
    notice.category === 'user_action' ||
    notice.category === 'system'
  );
}

function toastToneFromNotice(notice: DaemonSessionNotice): ToastTone {
  if (notice.severity === 'warning') return 'warning';
  if (notice.severity === 'info') return 'info';
  return 'error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getModelSwitchSummary(result: unknown): ModelSwitchSummary | null {
  if (!isRecord(result)) return null;
  const meta = result._meta;
  if (!isRecord(meta)) return null;
  const summary = meta.qwenModelSwitch;
  if (!isRecord(summary)) return null;
  const authType = summary.authType;
  const modelId = summary.modelId;
  const baseUrl = summary.baseUrl;
  const apiKey = summary.apiKey;
  if (
    typeof authType !== 'string' ||
    typeof modelId !== 'string' ||
    typeof baseUrl !== 'string' ||
    typeof apiKey !== 'string'
  ) {
    return null;
  }
  return {
    authType,
    modelId,
    baseUrl,
    apiKey,
    ...(typeof summary.isRuntime === 'boolean'
      ? { isRuntime: summary.isRuntime }
      : {}),
  };
}

function serializeModelSwitchSummary(
  summary: ModelSwitchSummary,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  return t('model.usingModel', {
    isRuntime: summary.isRuntime ? 1 : 0,
    modelId: summary.modelId,
  });
}

function isEditToolPermission(request: PermissionRequest): boolean {
  return request.toolKind === 'edit';
}

function parseRenameArgument(
  raw: string,
):
  | { type: 'auto' }
  | { type: 'manual'; displayName: string }
  | { type: 'delegate' } {
  const trimmed = raw.trim().replace(/[\r\n]+/g, ' ');
  if (!trimmed) return { type: 'auto' };
  if (trimmed === '--') return { type: 'manual', displayName: '' };
  if (trimmed.startsWith('-- ')) {
    return { type: 'manual', displayName: trimmed.slice(3).trim() };
  }
  if (trimmed.toLowerCase() === '--auto') return { type: 'auto' };
  if (trimmed.startsWith('--')) return { type: 'delegate' };
  return { type: 'manual', displayName: trimmed };
}

function isBackgroundShellToolCall(tool: ACPToolCall): boolean {
  if (tool.args?.is_background !== true) return false;
  const name = tool.toolName.toLowerCase();
  return (
    name === 'shell' ||
    name === 'bash' ||
    name === 'run_shell_command' ||
    name === 'exec'
  );
}

function getBackgroundTaskActivityKey(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      if (
        isBackgroundSubAgentToolCall(tool) ||
        isBackgroundShellToolCall(tool)
      ) {
        parts.push(`${tool.callId}:${tool.status}`);
      }
    }
  }
  return parts.join('|');
}

function mapToWebShellTaskInfo(
  task: DaemonSessionTaskStatus,
): WebShellTaskInfo {
  const base = {
    id: task.id,
    label: task.label,
    description: task.description,
    runtimeMs: task.runtimeMs,
    startTime: task.startTime,
    endTime: task.endTime,
    error: task.error,
  };

  switch (task.kind) {
    case 'agent':
      return {
        ...base,
        kind: 'agent',
        status: task.status,
        subagentType: task.subagentType,
        isBackgrounded: task.isBackgrounded,
        prompt: task.prompt,
      };
    case 'shell':
      return {
        ...base,
        kind: 'shell',
        status: task.status,
        command: task.command,
        cwd: task.cwd,
        pid: task.pid,
        exitCode: task.exitCode,
      };
    case 'monitor':
      return {
        ...base,
        kind: 'monitor',
        status: task.status,
        command: task.command,
        pid: task.pid,
        exitCode: task.exitCode,
      };
    default:
      return task satisfies never;
  }
}

function translateCopyMessage(
  message: string,
  t: ReturnType<typeof getTranslator>,
): string {
  if (message === COPY_MESSAGES.NO_OUTPUT) return t('copy.noOutput');
  if (message === COPY_MESSAGES.NO_TEXT) return t('copy.noText');
  if (message === COPY_MESSAGES.CODE_MISSING) return t('copy.codeMissing');
  if (message === COPY_MESSAGES.LATEX_MISSING) return t('copy.latexMissing');
  if (message === COPY_MESSAGES.INLINE_LATEX_MISSING) {
    return t('copy.inlineLatexMissing');
  }
  if (message === COPY_MESSAGES.OUTPUT_COPIED) return t('copy.outputCopied');
  if (message.startsWith(COPY_MESSAGES.CLIPBOARD_PREFIX)) {
    return `${t('copy.failedFallback')}. ${message.slice(
      COPY_MESSAGES.CLIPBOARD_PREFIX.length,
    )}`;
  }
  if (message.endsWith(COPY_MESSAGES.COPIED_SUFFIX)) {
    return t('copy.toClipboard', {
      label: message.slice(0, -COPY_MESSAGES.COPIED_SUFFIX.length),
    });
  }
  return message;
}

/**
 * Read a model setting's value for the scope currently being edited. Model
 * pickers persist to `modelSettingScope`, so their "current" value reflects
 * only that scope's own value (not the merged/effective one) — otherwise the
 * User tab would show, and appear to clear, an inherited workspace value.
 */
function readScopedModelSetting(
  settings: ReadonlyArray<{
    key: string;
    values: { effective: unknown; user?: unknown; workspace?: unknown };
  }>,
  scope: 'workspace' | 'user',
  key: string,
): unknown {
  const setting = settings.find((s) => s.key === key);
  if (!setting) return undefined;
  return scope === 'user' ? setting.values.user : setting.values.workspace;
}

export function App({
  onSessionIdChange,
  onSessionCreated,
  theme: providedTheme,
  onThemeChange,
  language: providedLanguage,
  onLanguageChange,
  className: externalClassName,
  style: externalStyle,
  onConnectionChange,
  onStreamingStateChange,
  onError,
  onBugReport,
  hiddenSlashCommands,
  slashCommandCategoryOrder,
  onSlashCommand,
  builtinAtProviders,
  atProviders,
  composerTagIcons,
  renderToolHeaderExtra,
  renderWelcomeHeader,
  renderWelcomeFooter,
  mobileWelcomeFooterMiddle = false,
  parseUserMessageContent,
  renderUserMessageContent,
  renderComposerTag,
  renderComposerTagTooltip,
  onComposerTagClick,
  renderAssistantTurnFooter,
  renderComposerToolbarStart,
  renderComposerToolbarEnd,
  renderComposerToolbarRight,
  renderComposerHeader,
  renderFooter,
  bottomStatusItems,
  chatMaxWidth,
  sidebar,
  splitSessionIds: externalSplitSessionIds,
  onSplitSessionIdsChange,
  onRightPanelOpen,
  messageTurnOutputs,
  shellRef,
  composerToolbarActions,
  composerPlaceholders,
  compactThinking = false,
  collapseCompletedTurns = true,
  markdownTableMode = 'basic',
  virtualScrollThreshold,
  markdown,
  loadingPhrases,
  onTranscriptChange,
  onToast,
  composerRef,
  onComposerReady,
  composerInput,
  composerInputVersion,
  onSessionChange,
  onSubmitBefore,
  restartSseOnPrompt,
  lockedWorkspaceCwd,
  lockedWorkspaceCapability,
}: AppProps = {}) {
  const [chatWidthMode, setChatWidthMode] =
    useState<ChatWidthMode>(readChatWidthMode);
  const [selectedLanguage, setSelectedLanguage] = useState<WebShellLanguage>(
    () =>
      providedLanguage === undefined
        ? getInitialLanguage()
        : normalizeLanguage(providedLanguage),
  );
  const t = useMemo(() => getTranslator(selectedLanguage), [selectedLanguage]);
  const sidebarOptions = useMemo(
    () => resolveSidebarOptions(sidebar),
    [sidebar],
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readSidebarCollapsed(sidebarOptions.defaultCollapsed),
  );
  const [sidebarSwitchingSessionId, setSidebarSwitchingSessionId] = useState<
    string | null
  >(null);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [forceMobileDrawer, setForceMobileDrawer] = useState(false);
  const closeMobileDrawer = useCallback(() => {
    setMobileDrawerOpen(false);
    setForceMobileDrawer(false);
  }, []);
  // The Session Overview panel (mission control for managing many sessions at
  // once) is only offered on large screens; below that there is no room for it
  // to be useful.
  const isLargeScreen = useIsLargeScreen();
  // In split view the session sidebar competes with the panes for width. Below
  // this width it auto-collapses to its icon rail so the panes get the room, and
  // expands again once the window grows back. A wide split keeps the full
  // sidebar (and the user's own collapse preference).
  const splitSidebarHasRoom = useIsLargeScreen('(min-width: 1200px)');

  useEffect(() => {
    if (!sidebarOptions.enabled) closeMobileDrawer();
  }, [closeMobileDrawer, sidebarOptions.enabled]);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 760px)');
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) closeMobileDrawer();
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [closeMobileDrawer]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A pending tool/permission approval owns Escape (it rejects the call),
      // so don't let the drawer swallow it while a prompt is visible.
      if (pendingApprovalRef.current) return;
      const target = e.target as HTMLElement | null;
      // Only let an editable element keep Escape for itself when it lives
      // outside the drawer; the drawer's own search input should still close
      // the drawer on the first Escape.
      if (
        isEditableTarget(target) &&
        !target?.closest('[data-sidebar-shell]')
      ) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      closeMobileDrawer();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const preventScroll = (e: TouchEvent) => {
      // Allow native scrolling inside the drawer panel (e.g. the session list).
      // The dim backdrop also lives under [data-sidebar-shell], so exclude it:
      // a touchmove starting on the backdrop must still be blocked, otherwise
      // iOS Safari scrolls the page behind the open drawer.
      const el = e.target as HTMLElement | null;
      if (
        el?.closest('[data-sidebar-shell]') &&
        !el.closest(`.${styles.mobileBackdrop}`)
      ) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener('touchmove', preventScroll, { passive: false });
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('touchmove', preventScroll);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [mobileDrawerOpen, closeMobileDrawer]);
  const handleSidebarCollapsedChange = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    writeSidebarCollapsed(collapsed);
  }, []);

  // #5074: Cmd+B / Ctrl+B toggles the session sidebar, matching the editor
  // convention (VS Code et al.). It works while any element is focused —
  // the composer has no bold formatting, so nothing competes for the
  // binding. Phone-width layouts render the sidebar as a drawer, so the
  // shortcut toggles that instead of the collapsed rail.
  useEffect(() => {
    if (!sidebarOptions.enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarToggleShortcut(e)) return;
      // The composer keeps the editor-convention behavior (VS Code toggles
      // the sidebar while the editor is focused), but other editable targets
      // — sidebar search, session rename, settings inputs — must not have
      // the sidebar yanked around while the user is typing, matching the
      // codebase's isEditableTarget convention.
      const target = e.target as HTMLElement | null;
      if (
        isEditableTarget(target) &&
        !target?.closest('[data-web-shell-composer-editor]')
      ) {
        return;
      }
      e.preventDefault();
      // All state updates are dispatched sequentially outside the updater
      // functions (React purity contract — mirrors the hamburger handler),
      // which is why this effect re-binds on state changes: the listener
      // closure must stay fresh.
      if (
        forceMobileDrawer ||
        window.matchMedia('(max-width: 760px)').matches
      ) {
        // A forced drawer on a wide viewport still belongs to the drawer
        // path: collapsing the rail underneath the overlay would look like
        // a no-op to the user.
        if (mobileDrawerOpen) {
          setMobileDrawerOpen(false);
          setForceMobileDrawer(false);
        } else {
          setMobileDrawerOpen(true);
        }
        return;
      }
      const next = !sidebarCollapsed;
      setSidebarCollapsed(next);
      writeSidebarCollapsed(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    sidebarOptions.enabled,
    mobileDrawerOpen,
    forceMobileDrawer,
    sidebarCollapsed,
  ]);
  const customization = useMemo(
    () => ({
      composerTagIcons,
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      parseUserMessageContent,
      renderUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      renderAssistantTurnFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderComposerToolbarRight,
      renderComposerHeader,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdownTableMode,
      markdown,
      loadingPhrases,
    }),
    [
      composerTagIcons,
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      parseUserMessageContent,
      renderUserMessageContent,
      renderComposerTag,
      renderComposerTagTooltip,
      onComposerTagClick,
      renderAssistantTurnFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderComposerToolbarRight,
      renderComposerHeader,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdownTableMode,
      markdown,
      loadingPhrases,
    ],
  );
  const CustomFooter = renderFooter;
  const CustomComposerHeader = renderComposerHeader;
  const store = useTranscriptStore();
  const blocks = useTranscriptBlocks();
  const connection = useConnection();
  const transcriptHistory = useTranscriptHistory();
  const workspace = useWorkspace();
  const workspaces = useMemo(() => {
    const capabilityWorkspaces = workspace.capabilities?.workspaces ?? [];
    if (
      lockedWorkspaceCapability &&
      !capabilityWorkspaces.some(
        (entry) => entry.cwd === lockedWorkspaceCapability.cwd,
      )
    ) {
      return [...capabilityWorkspaces, lockedWorkspaceCapability];
    }
    return capabilityWorkspaces;
  }, [lockedWorkspaceCapability, workspace.capabilities?.workspaces]);
  const visibleWorkspaces = useMemo(
    () =>
      lockedWorkspaceCwd
        ? workspaces.filter((entry) => entry.cwd === lockedWorkspaceCwd)
        : workspaces,
    [lockedWorkspaceCwd, workspaces],
  );
  const sessionActions = useActions();
  const { notices, dismissNotice } = useSessionNotices();
  const workspaceActions = useWorkspaceActions();
  // Phase 4: the workspace picked for the *next* new session on multi-workspace
  // daemons. Kept in a ref too because session creation is lazy (first prompt),
  // so the ensureSessionForPrompt callback must read the latest value.
  const [selectedWorkspaceCwd, setSelectedWorkspaceCwd] = useState<
    string | undefined
  >(undefined);
  const selectedWorkspaceCwdRef = useRef(selectedWorkspaceCwd);
  selectedWorkspaceCwdRef.current = selectedWorkspaceCwd;
  const [selectedWorkspaceGitStatus, setSelectedWorkspaceGitStatus] = useState<
    DaemonWorkspaceGitStatus | undefined
  >(undefined);
  // The workspace the chip's status was last fetched for. On a workspace switch
  // we clear the status immediately so the chip never shows the previous repo's
  // branch/dirty counts while the new fetch is in flight; same-workspace
  // re-runs (branch change, focus, poll) keep the live value to avoid flicker.
  const gitStatusWorkspaceCwdRef = useRef<string | undefined>(undefined);
  /** Worktree metadata for the current session (set after creation). */
  const [sessionWorktree, setSessionWorktree] = useState<
    { slug: string; path: string; branch: string } | undefined
  >(undefined);
  // Bumped on every user-initiated session switch so the async worktree
  // restore can tell apart "user switched away" from "connection.sessionId
  // transiently cycled through other sessions during the reconnect loop".
  const worktreeGenRef = useRef(0);
  // Restore worktree info from the server when switching to an existing
  // session. The effect intentionally does NOT cancel in-flight fetches on
  // cleanup: connection.sessionId can cycle through several sessions during
  // the DaemonSessionProvider reconnection loop, and cancelling would
  // discard the one response we actually need. Instead, the generation
  // counter guards against stale writes after a user-initiated switch.
  useEffect(() => {
    const sid = connection.sessionId;
    if (!sid) {
      setSessionWorktree(undefined);
      return;
    }
    const gen = worktreeGenRef.current;
    workspace.client
      .sessionStatus(sid)
      .then((summary) => {
        if (worktreeGenRef.current === gen && summary.worktree) {
          setSessionWorktree(summary.worktree);
        }
      })
      .catch(() => {
        // Non-live sessions 404 here; the sidecar-enriched session list
        // in the sidebar still shows the worktree badge.
      });
  }, [connection.sessionId, workspace.client]);
  // Active workspace: the connected session's workspace, else the workspace
  // picked for the next session (locked / selected / primary). Computed once
  // and shared by the git-status effect and the Changes-dialog entry point so
  // the chip and the dialog always target the same repo.
  const activeWorkspaceCwd = useMemo(
    () =>
      connection.sessionId
        ? connection.workspaceCwd
        : (lockedWorkspaceCwd ??
          selectedWorkspaceCwd ??
          workspaces.find((entry) => entry.primary)?.cwd),
    [
      connection.sessionId,
      connection.workspaceCwd,
      lockedWorkspaceCwd,
      selectedWorkspaceCwd,
      workspaces,
    ],
  );
  // Worktree sessions query git status with the worktree path (?cwd=
  // parameter); the chip prefers the live branch from that status, falling
  // back to the creation-time sessionWorktree.branch.
  useEffect(() => {
    if (!activeWorkspaceCwd) {
      gitStatusWorkspaceCwdRef.current = undefined;
      setSelectedWorkspaceGitStatus(undefined);
      return;
    }
    const statusTarget = sessionWorktree?.path ?? activeWorkspaceCwd;
    if (gitStatusWorkspaceCwdRef.current !== statusTarget) {
      gitStatusWorkspaceCwdRef.current = statusTarget;
      setSelectedWorkspaceGitStatus(undefined);
    }
    let cancelled = false;
    const fetchStatus = () => {
      void workspace.client
        .workspaceByCwd(activeWorkspaceCwd)
        .workspaceGit(sessionWorktree?.path)
        .then((git) => {
          if (!cancelled) setSelectedWorkspaceGitStatus(git);
        })
        .catch(() => {
          if (!cancelled) setSelectedWorkspaceGitStatus(undefined);
        });
    };
    fetchStatus();
    // The enriched working-tree summary isn't pushed over SSE, so refresh it on
    // focus and on a slow poll for the active workspace only. A live branch
    // change re-runs this effect via the connection.gitBranch dependency.
    const onFocus = () => fetchStatus();
    window.addEventListener('focus', onFocus);
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') fetchStatus();
    }, 30_000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(poll);
    };
  }, [
    activeWorkspaceCwd,
    connection.gitBranch,
    workspace.client,
    sessionWorktree,
  ]);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<WebShellToast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const pushToast = useCallback((tone: ToastTone, message: string) => {
    if (onToastRef.current) {
      onToastRef.current(tone, message);
      return;
    }
    const toast: WebShellToast = {
      id: `web-shell-toast-${Date.now()}-${++toastIdRef.current}`,
      tone,
      message,
    };
    setToasts((current) => {
      const withoutDuplicate = current.filter(
        (item) => item.tone !== tone || item.message !== message,
      );
      return [...withoutDuplicate, toast].slice(-MAX_TOASTS);
    });
  }, []);

  const messages = useMessages(t);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [recapMessage, setRecapMessage] = useState<LocalAnchoredMessage | null>(
    null,
  );
  const [btwMessage, setBtwMessage] = useState<Message | null>(null);
  const nextRecapMessageIdRef = useRef(1);
  const nextBtwMessageIdRef = useRef(1);
  const btwAbortControllerRef = useRef<AbortController | null>(null);
  const chatPaneRef = useRef<HTMLDivElement | null>(null);
  const currentSessionIdRef = useRef(connection.sessionId);
  const lastNotifiedSessionIdRef = useRef<string | undefined>(undefined);
  const lastNotifiedWorkspaceIdRef = useRef<string | undefined>(undefined);
  const lastNotifiedWorkspaceCwdRef = useRef<string | undefined>(undefined);
  const lastGoalSessionIdRef = useRef(connection.sessionId);
  const displayMessages = useMemo(() => {
    const localMessages = [recapMessage].filter(
      (message): message is LocalAnchoredMessage => message !== null,
    );
    if (localMessages.length === 0) {
      return filterModelSwitchMessages(messages);
    }

    const result = [...messages];
    for (const localMessage of localMessages.sort(
      (a, b) => a.anchorIndex - b.anchorIndex,
    )) {
      const anchorIndex = localMessage.anchorAfterId
        ? result.findIndex(
            (message) => message.id === localMessage.anchorAfterId,
          )
        : -1;
      const index =
        anchorIndex >= 0
          ? anchorIndex + 1
          : Math.min(localMessage.anchorIndex, result.length);
      result.splice(index, 0, localMessage.message);
    }
    return filterModelSwitchMessages(result);
  }, [messages, recapMessage]);
  const {
    artifacts,
    loading: artifactsLoading,
    error: artifactsError,
  } = useSessionArtifacts();
  const [artifactPanelExtraArtifacts, setArtifactPanelExtraArtifacts] =
    useState<DaemonSessionArtifact[]>([]);
  const [paneArtifactSnapshots, setPaneArtifactSnapshots] = useState<
    Map<string, PaneArtifactSnapshot>
  >(() => new Map());
  const [artifactPanelTabs, setArtifactPanelTabs] = useState<
    ArtifactPanelTab[]
  >([]);
  useEffect(() => {
    if (artifactPanelExtraArtifacts.length === 0 || artifacts.length === 0) {
      return;
    }
    const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
    const paneArtifactIds = new Set(
      artifactPanelTabs
        .filter((tab) => tab.kind === 'artifact' && tab.workspaceActions)
        .map((tab) => (tab.kind === 'artifact' ? tab.artifactId : '')),
    );
    setArtifactPanelExtraArtifacts((previous) => {
      const next = previous.filter(
        (artifact) =>
          !artifactIds.has(artifact.id) || paneArtifactIds.has(artifact.id),
      );
      return next.length === previous.length ? previous : next;
    });
  }, [artifacts, artifactPanelExtraArtifacts.length, artifactPanelTabs]);
  const paneArtifactExtras = useMemo(
    () =>
      Array.from(paneArtifactSnapshots.values()).flatMap((snapshot) => [
        ...snapshot.artifacts,
      ]),
    [paneArtifactSnapshots],
  );
  const artifactPanelArtifacts = useMemo(() => {
    if (
      artifactPanelExtraArtifacts.length === 0 &&
      paneArtifactExtras.length === 0
    ) {
      return artifacts;
    }
    const merged = [...artifacts];
    for (const artifact of [
      ...artifactPanelExtraArtifacts,
      ...paneArtifactExtras,
    ]) {
      const index = merged.findIndex((item) => item.id === artifact.id);
      if (index < 0) {
        merged.push(artifact);
      }
    }
    return merged;
  }, [artifacts, artifactPanelExtraArtifacts, paneArtifactExtras]);
  const handlePaneArtifactsChange = useCallback(
    (
      paneSessionId: string,
      paneArtifacts: readonly DaemonSessionArtifact[],
      paneWorkspaceActions: DaemonWorkspaceActions,
    ) => {
      setPaneArtifactSnapshots((current) => {
        const previous = current.get(paneSessionId);
        const unchanged =
          previous?.workspaceActions === paneWorkspaceActions &&
          previous.artifacts.length === paneArtifacts.length &&
          previous.artifacts.every((artifact, index) => {
            const nextArtifact = paneArtifacts[index];
            return (
              nextArtifact?.id === artifact.id &&
              nextArtifact.updatedAt === artifact.updatedAt &&
              nextArtifact.sizeBytes === artifact.sizeBytes
            );
          });
        if (unchanged) return current;
        const next = new Map(current);
        if (paneArtifacts.length === 0) {
          next.delete(paneSessionId);
        } else {
          next.set(paneSessionId, {
            artifacts: [...paneArtifacts],
            workspaceActions: paneWorkspaceActions,
          });
        }
        return next;
      });
      const artifactIds = new Set(paneArtifacts.map((artifact) => artifact.id));
      setArtifactPanelTabs((tabs) => {
        let changed = false;
        const next = tabs.map((tab) => {
          if (tab.kind !== 'artifact' || !artifactIds.has(tab.artifactId)) {
            return tab;
          }
          const updated = {
            id: tab.id,
            kind: 'artifact' as const,
            title: tab.title,
            artifactId: tab.artifactId,
            workspaceActions: tab.workspaceActions ?? paneWorkspaceActions,
          };
          if (tab.previewContent !== undefined) changed = true;
          if (tab.workspaceActions) return updated;
          changed = true;
          return updated;
        });
        return changed ? next : tabs;
      });
    },
    [],
  );
  const artifactsByTurn = useMemo(
    () =>
      getArtifactsByTurn(
        displayMessages,
        artifacts,
        connection.workspaceCwd || '',
      ),
    [displayMessages, artifacts, connection.workspaceCwd],
  );
  const fileChangesByTurn = useMemo(
    () =>
      getFileChangesByTurn(
        displayMessages,
        artifactsByTurn,
        connection.workspaceCwd || '',
      ),
    [displayMessages, artifactsByTurn, connection.workspaceCwd],
  );
  const scheduledTasksByTurn = useMemo(
    () => getScheduledTasksByTurn(displayMessages),
    [displayMessages],
  );
  const visibleTurnOutputKinds = useMemo(
    () => new Set<TurnOutputKind>(messageTurnOutputs ?? TURN_OUTPUT_KINDS),
    [messageTurnOutputs],
  );
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const artifactPanelOpenRef = useRef(artifactPanelOpen);
  artifactPanelOpenRef.current = artifactPanelOpen;
  const [activeArtifactPanelTabId, setActiveArtifactPanelTabId] = useState<
    string | null
  >(null);
  const activeArtifactPanelTabIdRef = useRef(activeArtifactPanelTabId);
  activeArtifactPanelTabIdRef.current = activeArtifactPanelTabId;
  const [reviewChanges, setReviewChanges] = useState<
    readonly TurnOutputFileChange[]
  >([]);
  const [selectedReviewPath, setSelectedReviewPath] = useState<string | null>(
    null,
  );
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(
    DEFAULT_REVIEW_PANEL_WIDTH,
  );
  const artifactPanelResizeCleanupRef = useRef<(() => void) | null>(null);
  const artifactPanelSessionStateRef = useRef<ArtifactPanelSessionState | null>(
    null,
  );
  const artifactPanelStateBySessionRef = useRef(
    new Map<string, ArtifactPanelSessionState>(),
  );
  const artifactPanelSessionIdRef = useRef(connection.sessionId);
  artifactPanelSessionStateRef.current = {
    open: artifactPanelOpen,
    tabs: artifactPanelTabs,
    activeTabId: activeArtifactPanelTabId,
    reviewChanges,
    selectedReviewPath,
    extraArtifacts: artifactPanelExtraArtifacts,
    width: artifactPanelWidth,
  };
  useEffect(() => {
    const previousSessionId = artifactPanelSessionIdRef.current;
    if (previousSessionId) {
      const currentState = artifactPanelSessionStateRef.current;
      if (currentState) {
        artifactPanelStateBySessionRef.current.set(
          previousSessionId,
          currentState,
        );
        if (
          artifactPanelStateBySessionRef.current.size >
          MAX_ARTIFACT_PANEL_SESSION_STATES
        ) {
          const oldestSessionId = artifactPanelStateBySessionRef.current
            .keys()
            .next().value;
          if (oldestSessionId) {
            artifactPanelStateBySessionRef.current.delete(oldestSessionId);
          }
        }
      }
    }

    const nextSessionId = connection.sessionId;
    artifactPanelSessionIdRef.current = nextSessionId;
    const savedState = nextSessionId
      ? artifactPanelStateBySessionRef.current.get(nextSessionId)
      : undefined;
    if (!savedState) {
      setArtifactPanelOpen(false);
      setArtifactPanelTabs([]);
      setActiveArtifactPanelTabId(null);
      setReviewChanges([]);
      setSelectedReviewPath(null);
      setArtifactPanelExtraArtifacts([]);
      setPaneArtifactSnapshots(new Map());
      setArtifactPanelWidth(DEFAULT_REVIEW_PANEL_WIDTH);
      return;
    }

    setArtifactPanelOpen(savedState.open);
    setArtifactPanelTabs(savedState.tabs);
    setActiveArtifactPanelTabId(savedState.activeTabId);
    setReviewChanges(savedState.reviewChanges);
    setSelectedReviewPath(savedState.selectedReviewPath);
    setArtifactPanelExtraArtifacts(savedState.extraArtifacts);
    setPaneArtifactSnapshots(new Map());
    setArtifactPanelWidth(savedState.width);
  }, [connection.sessionId]);
  const getMaxArtifactPanelWidth = useCallback(() => {
    const chatPaneWidth = chatPaneRef.current?.getBoundingClientRect().width;
    if (!chatPaneWidth) {
      return Math.max(
        MIN_ARTIFACT_PANEL_WIDTH,
        window.innerWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
      );
    }
    return Math.max(
      MIN_ARTIFACT_PANEL_WIDTH,
      artifactPanelWidth +
        chatPaneWidth -
        MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
    );
  }, [artifactPanelWidth]);
  const getDefaultReviewPanelWidth = useCallback(() => {
    const chatPaneWidth =
      chatPaneRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    const maxWidth = Math.max(
      MIN_ARTIFACT_PANEL_WIDTH,
      chatPaneWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
    );
    return Math.min(
      maxWidth,
      Math.max(DEFAULT_REVIEW_PANEL_WIDTH, Math.round(chatPaneWidth * 0.56)),
    );
  }, []);
  const openArtifactPanel = useCallback(
    (artifactId: string, previewContent?: string) => {
      if (!artifactId) return;
      const artifact = artifactPanelArtifacts.find(
        (item) => item.id === artifactId,
      );
      const tab: ArtifactPanelTab = {
        id: `artifact:${artifactId}`,
        kind: 'artifact',
        artifactId,
        title: artifact?.title ?? 'Artifact',
        ...(previewContent !== undefined ? { previewContent } : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) =>
              item.id === tab.id ? { ...item, ...tab } : item,
            )
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [artifactPanelArtifacts, getDefaultReviewPanelWidth],
  );
  const openReviewPanel = useCallback(
    (changes: readonly TurnOutputFileChange[], selectedPath?: string) => {
      const reviewTab: ArtifactPanelTab = {
        id: 'review',
        kind: 'review',
        title: t('turnOutputs.review'),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === reviewTab.id)
          ? tabs
          : [reviewTab, ...tabs],
      );
      setActiveArtifactPanelTabId(reviewTab.id);
      setReviewChanges(changes);
      setSelectedReviewPath(selectedPath ?? null);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const openScheduledTaskPanel = useCallback(
    (
      task: TurnOutputScheduledTask,
      tabWorkspaceActions?: ReturnType<typeof useWorkspaceActions>,
    ) => {
      const tab: ArtifactPanelTab = {
        id: `scheduled-task:${task.toolCallId}`,
        kind: 'scheduled_task',
        title: t('scheduledTasks.title'),
        task,
        ...(tabWorkspaceActions
          ? { workspaceActions: tabWorkspaceActions }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) => (item.id === tab.id ? tab : item))
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [getDefaultReviewPanelWidth, t],
  );
  const handleTurnOutputOpen = useCallback(
    (request: TurnOutputOpenRequest) => {
      if (onRightPanelOpen) {
        onRightPanelOpen(request);
        return;
      }
      if (request.kind === 'review') {
        openReviewPanel(request.changes, request.selectedPath);
        return;
      }
      if (request.kind === 'scheduled_task') {
        openScheduledTaskPanel(request.task, request.workspaceActions);
        return;
      }

      if (!request.workspaceActions) {
        setArtifactPanelExtraArtifacts((current) => {
          const index = current.findIndex(
            (artifact) => artifact.id === request.artifact.id,
          );
          if (index < 0) return [...current, request.artifact];
          const next = [...current];
          next[index] = request.artifact;
          return next;
        });
      }
      const tab: ArtifactPanelTab = {
        id: request.id,
        kind: 'artifact',
        title: request.title,
        artifactId: request.artifactId,
        ...(request.workspaceActions
          ? { workspaceActions: request.workspaceActions }
          : {}),
        ...(request.previewContent !== undefined
          ? { previewContent: request.previewContent }
          : {}),
      };
      setArtifactPanelTabs((tabs) =>
        tabs.some((item) => item.id === tab.id)
          ? tabs.map((item) =>
              item.id === tab.id ? { ...item, ...tab } : item,
            )
          : [...tabs, tab],
      );
      setActiveArtifactPanelTabId(tab.id);
      setArtifactPanelWidth((width) =>
        artifactPanelOpenRef.current ? width : getDefaultReviewPanelWidth(),
      );
      setArtifactPanelOpen(true);
    },
    [
      getDefaultReviewPanelWidth,
      onRightPanelOpen,
      openReviewPanel,
      openScheduledTaskPanel,
    ],
  );
  const closeArtifactPanel = useCallback(() => {
    setArtifactPanelOpen(false);
    setArtifactPanelTabs([]);
    setActiveArtifactPanelTabId(null);
    setReviewChanges([]);
    setSelectedReviewPath(null);
    setArtifactPanelExtraArtifacts([]);
    setPaneArtifactSnapshots(new Map());
  }, []);
  useLayoutEffect(() => {
    if (!artifactPanelOpen) return;
    const clampWidth = () => {
      setArtifactPanelWidth((width) => {
        const chatPaneWidth =
          chatPaneRef.current?.getBoundingClientRect().width ??
          window.innerWidth - width;
        const maxWidth = Math.max(
          MIN_ARTIFACT_PANEL_WIDTH,
          width + chatPaneWidth - MIN_CHAT_PANE_WIDTH_WITH_ARTIFACT_PANEL,
        );
        return Math.min(width, maxWidth);
      });
    };
    clampWidth();
    window.addEventListener('resize', clampWidth);
    const chatPane = chatPaneRef.current;
    const observer = new ResizeObserver(clampWidth);
    if (chatPane) observer.observe(chatPane);
    return () => {
      window.removeEventListener('resize', clampWidth);
      observer.disconnect();
    };
  }, [artifactPanelOpen]);
  const closeArtifactPanelTab = useCallback((tabId: string) => {
    setArtifactPanelTabs((tabs) => {
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      if (nextTabs.length === 0) {
        setArtifactPanelOpen(false);
        setActiveArtifactPanelTabId(null);
        setReviewChanges([]);
        setSelectedReviewPath(null);
        setArtifactPanelExtraArtifacts([]);
        setPaneArtifactSnapshots(new Map());
        return nextTabs;
      }
      if (activeArtifactPanelTabIdRef.current === tabId) {
        const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
        const nextActive =
          nextTabs[Math.min(closedIndex, nextTabs.length - 1)] ?? nextTabs[0];
        setActiveArtifactPanelTabId(nextActive.id);
      }
      return nextTabs;
    });
  }, []);
  const handleArtifactPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const resizeHandle = event.currentTarget;
      resizeHandle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = artifactPanelWidth;
      const maxWidth = getMaxArtifactPanelWidth();
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      let pendingWidth = startWidth;
      let animationFrame: number | null = null;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const flushWidth = () => {
        animationFrame = null;
        setArtifactPanelWidth(pendingWidth);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        pendingWidth = Math.min(
          maxWidth,
          Math.max(
            MIN_ARTIFACT_PANEL_WIDTH,
            startWidth - (moveEvent.clientX - startX),
          ),
        );
        if (animationFrame === null) {
          animationFrame = window.requestAnimationFrame(flushWidth);
        }
      };
      let handlePointerUp: () => void = () => {};
      const cleanupResize = (commitWidth: boolean) => {
        artifactPanelResizeCleanupRef.current = null;
        if (animationFrame !== null) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = null;
        }
        if (commitWidth) setArtifactPanelWidth(pendingWidth);
        if (resizeHandle.hasPointerCapture(event.pointerId)) {
          resizeHandle.releasePointerCapture(event.pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
      };
      handlePointerUp = () => cleanupResize(true);
      artifactPanelResizeCleanupRef.current = () => cleanupResize(false);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [artifactPanelWidth, getMaxArtifactPanelWidth],
  );
  useEffect(() => () => artifactPanelResizeCleanupRef.current?.(), []);
  const messageBlocks = useAnimationFrameValue(blocks);
  const rawPendingApproval = useMemo(
    () => extractPendingPermission(messageBlocks),
    [messageBlocks],
  );
  const pendingApproval = useShallowMemo(rawPendingApproval);
  const canActOnPendingApproval = !(
    connection.catchingUp && sidebarSwitchingSessionId !== null
  );
  const pendingAskUserApproval = isAskUserPermission(pendingApproval)
    ? canActOnPendingApproval
      ? pendingApproval
      : null
    : null;
  const pendingToolApproval =
    pendingApproval && !isAskUserPermission(pendingApproval)
      ? canActOnPendingApproval
        ? pendingApproval
        : null
      : null;
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = canActOnPendingApproval ? pendingApproval : null;
  // True exactly when an actionable approval overlay (ToolApproval or
  // AskUserQuestion) is on screen. Single source of truth for the three places
  // that must treat the composer as dormant while an approval owns the keyboard:
  // the panel auto-close, the panel focus-restore guard, and the ChatEditor
  // dialogOpen prop.
  const approvalOverlayActive =
    pendingToolApproval !== null || pendingAskUserApproval !== null;
  const approvalOverlayActiveRef = useRef(approvalOverlayActive);
  approvalOverlayActiveRef.current =
    approvalOverlayActive ||
    (canActOnPendingApproval && extractPendingPermission(blocks) !== null);
  const floatingTodosState = useMemo(
    () => getFloatingTodos(messages),
    [messages],
  );
  // Keep the timeline Map referentially stable across streaming ticks that
  // don't touch any todo snapshot. The Map is a context value, so a fresh
  // reference would re-render every todo/plan row regardless of memoization;
  // only rebuild when the todo snapshots themselves change.
  const todoTimelineRef = useRef<{
    signature: string;
    timeline: Map<string, TodoSnapshotDiff>;
  } | null>(null);
  const todoTimeline = useMemo(() => {
    const signature = todoTimelineSignature(messages);
    const cached = todoTimelineRef.current;
    if (cached && cached.signature === signature) return cached.timeline;
    const timeline = computeTodoTimeline(messages);
    todoTimelineRef.current = { signature, timeline };
    return timeline;
  }, [messages]);
  // Per-todo detail (start/end + token/API/tool spend) is derived entirely from
  // the transcript: the agent stamps a cumulative-usage snapshot on each todo
  // update and the web-shell diffs consecutive snapshots, so this works live and
  // on resume with no polling. Kept referentially stable like the timeline
  // above (rebuilt only when a relevant snapshot, timestamp, stat, or tool span
  // changes) so an unrelated streaming tick doesn't re-render every expanded
  // todo row that consumes TodoDetailContext.
  const todoDetailRef = useRef<{
    signature: string;
    details: Map<string, TodoDetail>;
  } | null>(null);
  const todoDetails = useMemo(() => {
    const signature = todoDetailSignature(messages);
    const cached = todoDetailRef.current;
    if (cached && cached.signature === signature) return cached.details;
    const details = computeTodoDetails(messages);
    todoDetailRef.current = { signature, details };
    return details;
  }, [messages]);
  const floatingTodos = useStableArray(
    floatingTodosState.todos,
    (t) => `${t.id}:${t.status}:${t.content}`,
  );
  const floatingTodosAllCompleted = floatingTodosState.allCompleted;
  const [todoPanelMode, setTodoPanelMode] = useState<'hidden' | 'active'>(
    'hidden',
  );
  const nextTodoPanelMode =
    connection.catchingUp ||
    floatingTodos.length === 0 ||
    floatingTodosAllCompleted
      ? 'hidden'
      : 'active';
  if (nextTodoPanelMode !== todoPanelMode) {
    setTodoPanelMode(nextTodoPanelMode);
  }
  const showFloatingTodos = nextTodoPanelMode !== 'hidden';
  const floatingBottomStatusItems =
    bottomStatusItems ?? EMPTY_BOTTOM_STATUS_ITEMS;
  const showBottomPanels =
    showFloatingTodos || floatingBottomStatusItems.length > 0;
  const footerRef = useRef<HTMLDivElement>(null);
  const appRootRef = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const portalRootVariableNamesRef = useRef<Set<string>>(new Set());
  const bottomPanelsRef = useRef<HTMLDivElement>(null);
  const [bottomPanelInset, setBottomPanelInset] = useState(0);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(0);
  useLayoutEffect(() => {
    if (!showBottomPanels) {
      setBottomPanelInset(0);
      setBottomPanelHeight(0);
      return;
    }
    const node = bottomPanelsRef.current;
    if (!node) {
      setBottomPanelInset(BOTTOM_PANEL_FALLBACK_INSET_PX);
      setBottomPanelHeight(0);
      return;
    }
    const updateInset = () => {
      const footer = footerRef.current;
      const panelRect = node.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const panelHeight = Math.ceil(panelRect.height);
      const overlapAboveFooter = footerRect
        ? Math.max(0, footerRect.top - panelRect.top)
        : panelHeight + BOTTOM_PANEL_GAP_PX;
      setBottomPanelHeight(panelHeight);
      setBottomPanelInset(
        Math.max(BOTTOM_PANEL_FALLBACK_INSET_PX, Math.ceil(overlapAboveFooter)),
      );
    };
    updateInset();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateInset);
    observer.observe(node);
    if (footerRef.current) observer.observe(footerRef.current);
    return () => observer.disconnect();
  }, [showBottomPanels]);
  const contentStyle = useMemo(
    () =>
      ({
        '--web-shell-bottom-panel-inset': `${bottomPanelInset}px`,
        '--web-shell-bottom-panel-height': `${bottomPanelHeight}px`,
        '--web-shell-bottom-panel-gap': `${BOTTOM_PANEL_GAP_PX}px`,
      }) as CSSProperties,
    [bottomPanelHeight, bottomPanelInset],
  );
  const backgroundTaskActivityKey = useMemo(
    () => getBackgroundTaskActivityKey(messages),
    [messages],
  );
  const [backgroundTasksRefreshTrigger, setBackgroundTasksRefreshTrigger] =
    useState(0);
  const backgroundTasks = useBackgroundTasks(
    backgroundTaskActivityKey,
    connection.status === 'connected',
    backgroundTasksRefreshTrigger,
  );
  const footerTasks = useMemo(
    () => (renderFooter ? backgroundTasks.map(mapToWebShellTaskInfo) : []),
    [backgroundTasks, renderFooter],
  );
  const statusBarRef = useRef<StatusBarHandle>(null);
  const messageListRef = useRef<MessageListHandle | null>(null);
  const editorRef = useRef<EditorHandle | null>(null);
  const notifiedComposerReadyRef = useRef<EditorHandle | null>(null);
  const [canScrollMessageListToBottom, setCanScrollMessageListToBottom] =
    useState(false);
  const previousFooterRectRef = useRef<DOMRect | null>(null);
  const previousEmptyStateRef = useRef(false);
  const resumeChatBottomFollow = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToBottom(behavior);
        requestAnimationFrame(() => {
          messageListRef.current?.scrollToBottom(behavior);
        });
      });
    },
    [],
  );
  const setEditorHandle = useCallback(
    (handle: EditorHandle | null) => {
      editorRef.current = handle;
      assignComposerRef(composerRef, handle ?? emptyComposerApi);
      if (handle && notifiedComposerReadyRef.current !== handle) {
        notifiedComposerReadyRef.current = handle;
        onComposerReady?.(handle);
      }
    },
    [composerRef, onComposerReady],
  );
  useEffect(() => {
    assignComposerRef(composerRef, editorRef.current ?? emptyComposerApi);
  }, [composerRef]);
  const [activeGoal, setActiveGoal] = useState<ActiveGoalStatus | null>(null);
  const [isCreatingMissingSession, setIsCreatingMissingSession] =
    useState(false);
  const creatingMissingSessionRef = useRef(false);
  const activeGoalRef = useRef<ActiveGoalStatus | null>(null);
  activeGoalRef.current = activeGoal;
  const {
    followupState,
    onAcceptFollowup,
    onDismissFollowup,
    clear: clearFollowup,
  } = useDaemonFollowupSuggestion({
    onAccept: (suggestion) => {
      editorRef.current?.insertText(suggestion);
    },
  });
  const composerTextRef = useRef('');
  const composerTextDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [composerText, setComposerText] = useState('');
  const [isStartingNewSessionSuggestion, setIsStartingNewSessionSuggestion] =
    useState(false);
  const streamingState = useStreamingState();
  const streamingStateRef = useRef<DaemonStreamingState>(streamingState);
  const localStreamingStartedAtRef = useRef(Date.now());
  const previousStreamingStateRef =
    useRef<DaemonStreamingState>(streamingState);
  if (
    previousStreamingStateRef.current === 'idle' &&
    streamingState !== 'idle'
  ) {
    localStreamingStartedAtRef.current = Date.now();
  }
  previousStreamingStateRef.current = streamingState;
  const activeTurnStartedAt = useMemo(() => {
    if (streamingState === 'idle') return undefined;
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      const message = displayMessages[i];
      if (message?.role === 'user') {
        return message.timestamp ?? localStreamingStartedAtRef.current;
      }
    }
    return localStreamingStartedAtRef.current;
  }, [displayMessages, streamingState]);
  const lastSubmittedPromptRef = useRef<string>('');
  const lastSubmittedImagesRef = useRef<PromptImage[] | undefined>(undefined);
  const retryableTurnErrorIdRef = useRef<string | null>(null);
  const retriedTurnErrorIdRef = useRef<string | null>(null);
  const [showRetryHint, setShowRetryHint] = useState(false);
  const showRetryHintRef = useRef(showRetryHint);
  showRetryHintRef.current = showRetryHint;
  const connected = connection.status === 'connected';
  const workspaceEventSignals = useWorkspaceEventSignals();
  const [loadedSkills, setLoadedSkills] = useState<SkillInfo[]>([]);
  const [loadedSkillsReady, setLoadedSkillsReady] = useState(false);
  const loadedSkillsRequestRef = useRef(0);
  const reloadLoadedSkills = useCallback(
    async (workspaceCwd?: string) => {
      const request = ++loadedSkillsRequestRef.current;
      try {
        const status =
          workspaceCwd && workspace.client
            ? await workspace.client
                .workspaceByCwd(workspaceCwd)
                .workspaceSkills()
            : await workspaceActions.loadSkillsStatus();
        if (request !== loadedSkillsRequestRef.current) return;
        setLoadedSkills(availableSkillInfos(status));
        setLoadedSkillsReady(true);
      } catch {
        return;
      }
    },
    [workspace.client, workspaceActions],
  );
  useEffect(() => {
    if (!connected) return;
    void reloadLoadedSkills(connection.workspaceCwd);
  }, [connected, connection.workspaceCwd, reloadLoadedSkills]);

  const [modelDialogMode, setModelDialogMode] =
    useState<ModelDialogMode | null>(null);
  // Mirror of modelDialogMode (and the fallbacks/auth dialog flags below) for
  // reading the latest values inside the async voice loadProviders callback, so
  // it doesn't open the voice picker on top of a surface opened while loading
  // (see the voiceModel branch in onSubDialog).
  const modelDialogModeRef = useRef<ModelDialogMode | null>(modelDialogMode);
  // Scope a model sub-dialog opened from the Settings panel persists to. Set
  // when opening from the User/Workspace settings tab; reset to 'workspace'
  // whenever the model dialog closes (any path) so command-launched pickers
  // (/model --vision, etc.) always write workspace.
  const [modelSettingScope, setModelSettingScope] = useState<
    'workspace' | 'user'
  >('workspace');
  const [showFallbacksDialog, setShowFallbacksDialog] = useState(false);
  const showFallbacksDialogRef = useRef(showFallbacksDialog);
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[]>([]);
  const [showApprovalModeDialog, setShowApprovalModeDialog] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [showRewindDialog, setShowRewindDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showToolsDialog, setShowToolsDialog] = useState(false);
  // The workspace the Git dialog reads. Set by whichever entry point opened
  // it — the composer git chip / `/diff` (current workspace) or a sidebar
  // folder's git chip (that workspace) — so each can target its own repo.
  const [gitDialog, setGitDialog] = useState<
    { workspaceCwd: string; view: GitDialogView } | undefined
  >(undefined);
  // Main content view. The scheduled-tasks page replaces the chat pane inline
  // (not a modal overlay), mirroring the reference design; creating or opening
  // a chat returns to 'chat'. (Daemon Status is no longer a boolean dialog — it
  // is one of the activePanel values below.)
  const [mainView, setMainView] = useState<
    'chat' | 'scheduledTasks' | 'goals' | 'split'
  >('chat');
  // Sessions to seed the split view with (e.g. the selection from the overview).
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>([]);
  // Latest pane list, readable from the shrink-close effect without making it a
  // dependency (it changes on every pane add/remove).
  const splitSessionIdsRef = useRef<string[]>(splitSessionIds);
  splitSessionIdsRef.current = splitSessionIds;
  const [mcpDialogMessage, setMcpDialogMessage] =
    useState<SerializedMcpStatusMessage | null>(null);
  // Settings and Daemon Status are shown as an in-place panel that replaces the
  // chat view (message list + composer), not as a modal overlay. Only one may be
  // active at a time; null means the normal chat view is shown.
  const [activePanel, setActivePanel] = useState<
    | 'settings'
    | 'status'
    | 'sessions'
    | 'extensions'
    | 'mcp'
    | 'skills'
    | 'plugins'
    | null
  >(null);
  const closePanel = useCallback(() => setActivePanel(null), []);
  const handleUseSkill = useCallback(
    (name: string) => {
      closePanel();
      window.setTimeout(() => {
        editorRef.current?.setText(`/${name} `);
        editorRef.current?.focus();
      }, 0);
    },
    [closePanel],
  );
  // The Settings/Status panel (activePanel) and the Scheduled Tasks page
  // (mainView) are mutually-exclusive full-pane views — the latter is a
  // position:absolute overlay that would otherwise cover the former — so opening
  // one closes the other. Without this, opening Scheduled Tasks then Daemon
  // Status left the panel rendered behind the Scheduled Tasks overlay, looking
  // like the button did nothing.
  const openPanel = useCallback(
    (
      panel:
        | 'settings'
        | 'status'
        | 'sessions'
        | 'extensions'
        | 'mcp'
        | 'skills'
        | 'plugins',
    ) => {
      setMainView('chat');
      setActivePanel(panel);
    },
    [],
  );
  const loadMcpManagerMessage = useCallback(async () => {
    const status = await workspaceActions.loadMcpStatus();
    setMcpDialogMessage({
      status,
      toolsByServer: {},
      resourcesByServer: {},
      showDescriptions: false,
      showSchema: false,
      showTips: false,
    });
  }, [workspaceActions]);
  const openScheduledTasks = useCallback(() => {
    setActivePanel(null);
    setMainView('scheduledTasks');
  }, []);
  const openGoals = useCallback(() => {
    setActivePanel(null);
    setMainView('goals');
  }, []);
  const openSessionDrawer = useCallback(() => {
    if (!sidebarOptions.enabled) return;
    setActivePanel(null);
    setMainView('chat');
    setForceMobileDrawer(true);
    setMobileDrawerOpen(true);
  }, [sidebarOptions.enabled]);
  // Open the in-window split view showing 2+ sessions side by side. `splitSessionIds`
  // is the live pane set — SplitView mirrors add/remove back into it via
  // onPanesChange — so it must be preserved across entries, not blindly reset.
  const openSplitView = useCallback(
    (sessionIds?: readonly string[]) => {
      setActivePanel(null);
      setSplitSessionIds((prev) => {
        // An explicit selection (the overview, or a `?split=` URL) replaces the
        // split with exactly those sessions.
        const requested = Array.from(
          new Set((sessionIds ?? []).filter(Boolean)),
        ).slice(0, MAX_SPLIT_PANES);
        if (requested.length > 0) return requested;
        // No selection (the toolbar "Open Split View" button): restore the split
        // the user already had so switching away and back doesn't clear it; fall
        // back to the current session when there is nothing to restore.
        if (prev.length > 0) return prev;
        return connection.sessionId ? [connection.sessionId] : [];
      });
      setMainView('split');
    },
    [connection.sessionId],
  );
  const externalSplitSignature = useMemo(() => {
    const requested = Array.from(
      new Set((externalSplitSessionIds ?? []).filter(Boolean)),
    ).slice(0, MAX_SPLIT_PANES);
    return requested.join('\0');
  }, [externalSplitSessionIds]);
  const externalSplitControlled = externalSplitSessionIds !== undefined;
  const onSplitSessionIdsChangeRef = useRef(onSplitSessionIdsChange);
  onSplitSessionIdsChangeRef.current = onSplitSessionIdsChange;
  const requestOpenSplitView = useCallback(() => {
    if (!externalSplitControlled) {
      openSplitView();
      return;
    }
    const requested =
      splitSessionIds.length > 0
        ? splitSessionIds
        : connection.sessionId
          ? [connection.sessionId]
          : [];
    onSplitSessionIdsChangeRef.current?.(requested);
  }, [
    connection.sessionId,
    externalSplitControlled,
    openSplitView,
    splitSessionIds,
  ]);
  useEffect(() => {
    if (!externalSplitControlled) return;
    const requested = externalSplitSignature
      ? externalSplitSignature.split('\0')
      : [];
    setSplitSessionIds((prev) =>
      areSessionIdsEqual(prev, requested) ? prev : requested,
    );
    if (requested.length > 0) {
      setActivePanel((prev) => (prev === null ? prev : null));
      setMainView((prev) => (prev === 'split' ? prev : 'split'));
    } else {
      setMainView((prev) => (prev === 'split' ? 'chat' : prev));
    }
  }, [externalSplitControlled, externalSplitSignature]);
  const handleSplitPanesChange = useCallback(
    (sessionIds: string[]) => {
      if (!externalSplitControlled) {
        setSplitSessionIds(sessionIds);
      }
      onSplitSessionIdsChangeRef.current?.(sessionIds);
    },
    [externalSplitControlled],
  );
  const notifyControlledSplitClose = useCallback(() => {
    if (externalSplitControlled) {
      onSplitSessionIdsChangeRef.current?.([]);
    }
  }, [externalSplitControlled]);
  // Stable so SplitView's onExit-dependent effect (auto-exit on last pane
  // close) doesn't re-fire on every App re-render. Back from the split returns
  // to the Session Overview — the hub the split is launched from.
  const handleSplitExit = useCallback(() => {
    notifyControlledSplitClose();
    // The user left the split of their own accord, so a refresh must not bring
    // it back. (A shrink-fold is transient and deliberately doesn't clear it.)
    clearSplitSessions();
    openPanel('sessions');
  }, [notifyControlledSplitClose, openPanel]);
  // A `?split=a,b` URL (opened in a new tab from the overview) enters the split
  // view with those sessions on load. Consume the param once so a later reload
  // or exit doesn't force the split back on.
  useEffect(() => {
    const ids = parseSplitSessionIds(window.location.search);
    if (ids.length > 0) {
      const url = new URL(window.location.href);
      url.searchParams.delete('split');
      window.history.replaceState(null, '', url);
      if (!externalSplitControlled) {
        openSplitView(ids);
      }
      return;
    }
    // No `?split=` deep link: restore the in-window split the user had before a
    // refresh, when one was persisted for this tab. sessionStorage is per-tab,
    // so a fresh tab (or a controlled host, which owns its own lifecycle)
    // restores nothing.
    if (externalSplitControlled) return;
    const saved = loadSplitSessions();
    if (saved.length > 0) openSplitView(saved);
  }, [externalSplitControlled, openSplitView]);
  // Mirror the live split session set to per-tab storage while the split is the
  // active view, so a refresh restores exactly these panes. Not written when the
  // split is merely folded by a shrink (mainView flips to 'chat' transiently) —
  // the saved set is kept so growing back, or refreshing mid-fold, still restores.
  useEffect(() => {
    if (externalSplitControlled) return;
    if (mainView === 'split' && splitSessionIds.length > 0) {
      saveSplitSessions(splitSessionIds);
    }
  }, [mainView, splitSessionIds, externalSplitControlled]);
  // If the viewport shrinks below the large-screen breakpoint, fold away the
  // Session Overview panel and the split view — both are large-screen-only
  // surfaces whose entry points are hidden on small screens. The split is only
  // folded, not discarded: growing back past the breakpoint restores it, so a
  // transient resize is lossless. When a shrink folds the split, its panes
  // unmount and take keyboard focus with them; flag the composer to be refocused
  // once the chat is shown again.
  const focusComposerAfterSplitCloseRef = useRef(false);
  // True while the split view is only *temporarily* folded away because the
  // window is narrower than the large-screen breakpoint. Growing back past the
  // breakpoint restores it, so a transient resize doesn't drop the user's panes.
  const splitFoldedByShrinkRef = useRef(false);
  useEffect(() => {
    if (isLargeScreen) {
      // Grew back above the breakpoint: restore a split that a shrink folded
      // away. Standalone/uncontrolled only — a controlled host owns its split
      // lifecycle and re-opens it itself.
      if (splitFoldedByShrinkRef.current) {
        splitFoldedByShrinkRef.current = false;
        if (!externalSplitControlled && splitSessionIdsRef.current.length > 0) {
          setMainView((prev) => (prev === 'chat' ? 'split' : prev));
        }
      }
      return;
    }
    if (activePanel === 'sessions') {
      setActivePanel(null);
    }
    if (mainView === 'split') {
      notifyControlledSplitClose();
      setMainView('chat');
      focusComposerAfterSplitCloseRef.current = true;
      // Fold, don't discard: remember to restore the same split once the screen
      // grows back, so a transient shrink is lossless. The chat's own connection
      // (its session, git branch, URL, …) is left untouched — restoring the
      // split, or dropping back to that chat, is exactly what it was before.
      if (!externalSplitControlled) {
        splitFoldedByShrinkRef.current = true;
        // …except when the chat has no session of its own — the common case
        // when the split was entered from the Session Overview or a `?split=a,b`
        // link. A bare fold would then strand the user on an empty "new chat",
        // so land on the split's first (leftmost) pane instead. Guarded on the
        // *empty* chat so it never re-points a chat that already has a session
        // (which would wipe its git branch / change the session+URL it drops
        // back to). Best-effort: a load failure (e.g. a non-primary-workspace
        // pane the single connection can't own) just leaves the empty chat.
        const firstPane = splitSessionIdsRef.current[0];
        if (firstPane && !currentSessionIdRef.current) {
          void sessionActions.loadSession(firstPane).catch(() => undefined);
        }
      }
    }
  }, [
    isLargeScreen,
    activePanel,
    mainView,
    notifyControlledSplitClose,
    externalSplitControlled,
    sessionActions,
  ]);
  // Land focus on the composer after a shrink-driven split close so keyboard
  // users aren't dropped onto <body> — but not when the chat now shows an
  // approval overlay (it owns the keyboard) or a panel (it manages focus).
  useEffect(() => {
    if (mainView !== 'chat' || !focusComposerAfterSplitCloseRef.current) return;
    focusComposerAfterSplitCloseRef.current = false;
    if (!activePanel && !approvalOverlayActive) editorRef.current?.focus();
  }, [mainView, activePanel, approvalOverlayActive]);
  // The Settings / Daemon Status panel is a view, not a modal, so it lacks
  // DialogShell's focus trap/restore. Move focus into a panel when it opens (or
  // when switching directly between panels) and back to the composer when it
  // closes, so keyboard users aren't stranded on an element that is hidden.
  const panelBackRef = useRef<HTMLButtonElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pluginTabRef = useRef<HTMLButtonElement | null>(null);
  const prevActivePanelRef = useRef(activePanel);
  const prevApprovalOverlayRef = useRef(approvalOverlayActive);
  useEffect(() => {
    const prev = prevActivePanelRef.current;
    const wasApprovalActive = prevApprovalOverlayRef.current;
    prevActivePanelRef.current = activePanel;
    prevApprovalOverlayRef.current = approvalOverlayActive;
    if (activePanel) {
      if (activePanel === 'extensions') {
        panelHeadingRef.current?.focus();
        return;
      }
      if (activePanel === 'plugins') {
        pluginTabRef.current?.focus();
        return;
      }
      // Covers null→panel and panel→panel: the Back button lives outside the
      // keyed panel body so it survives a switch, but refocus explicitly rather
      // than depending on that DOM coincidence.
      panelBackRef.current?.focus();
    } else if (prev) {
      // Panel just closed. Return focus to the composer — unless an approval
      // overlay is what forced it closed (see the effect below): that overlay
      // drives its own keyboard handling and ToolApproval ignores keys from
      // editable targets, so focusing the composer here would swallow its
      // shortcuts and leave the user unable to respond by keyboard.
      if (!approvalOverlayActive) {
        editorRef.current?.focus();
      }
    } else if (wasApprovalActive && !approvalOverlayActive) {
      // The panel was auto-closed for an approval (prev was consumed to null on
      // that render, editor focus skipped). Now the approval has resolved with
      // no panel to return to, so restore the composer here. (useComposerCore's
      // dialogOpen effect also refocuses on this transition; this keeps the
      // panel focus effect self-contained instead of relying on that.)
      editorRef.current?.focus();
    }
  }, [activePanel, approvalOverlayActive]);
  // A pending approval (a gated tool call or an AskUserQuestion) renders its
  // overlay in the chat footer, which is hidden (display:none) while a panel is
  // shown. Left alone, the turn would hang behind Settings/Status with no
  // visible prompt. Close the panel so the approval surfaces. Only actionable
  // approvals count — pendingToolApproval/pendingAskUserApproval already gate on
  // canActOnPendingApproval, so a non-owner in a shared session isn't yanked out
  // of Settings by someone else's prompt.
  useEffect(() => {
    if (!approvalOverlayActive) return;
    // The approval overlay renders in the chat footer; dismiss anything layered
    // over it so it's visible and actionable instead of trapped behind a
    // backdrop — the panel itself and any DialogShell sub-dialog opened from it
    // (model picker, approval-mode picker). Leaving the approval-mode picker up
    // is also a security hole: the user could pick "yolo" and silently
    // auto-approve a tool call they never saw (handleSetMode auto-approves
    // pendingApprovalRef.current).
    if (activePanel) setActivePanel(null);
    if (modelDialogMode) setModelDialogMode(null);
    if (showApprovalModeDialog) setShowApprovalModeDialog(false);
    // The Scheduled Tasks and Goals pages are full-pane overlays
    // (position:absolute) that cover the chat footer too, so dismiss them for
    // the same reason. The split view is deliberately NOT dismissed: each pane
    // owns and renders its own session's approval, so an approval on the (outer)
    // main session must not yank the user out of the panes they are working in.
    if (mainView === 'scheduledTasks' || mainView === 'goals') {
      setMainView('chat');
    }
  }, [
    approvalOverlayActive,
    activePanel,
    modelDialogMode,
    showApprovalModeDialog,
    mainView,
  ]);
  // Whether each approval overlay is the topmost (visible, uncovered) one. The
  // overlay components consume this as `keyboardActive`: when it flips true — on
  // appearance, or once a panel/dialog that was covering it closes — they pull
  // keyboard focus to their own safe-default option. Focus handling now lives in
  // ToolApproval/AskUserQuestion (their keyboard handling is focus-scoped), so
  // the app no longer focuses the wrapper element directly.
  const toolApprovalOverlayVisible =
    pendingToolApproval !== null &&
    !activePanel &&
    modelDialogMode === null &&
    !showApprovalModeDialog &&
    mainView === 'chat';
  const askUserOverlayVisible =
    pendingAskUserApproval !== null &&
    !activePanel &&
    modelDialogMode === null &&
    !showApprovalModeDialog &&
    mainView === 'chat';
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const showAuthDialogRef = useRef(showAuthDialog);
  const [memoryRefreshSignal, setMemoryRefreshSignal] = useState(0);
  const [memoryAddSignal, setMemoryAddSignal] = useState(0);
  const [externalInteractionBlockCount, setExternalInteractionBlockCount] =
    useState(0);
  const registerInteractionBlocker = useCallback(() => {
    let released = false;
    setExternalInteractionBlockCount((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setExternalInteractionBlockCount((count) => Math.max(0, count - 1));
    };
  }, []);

  // Refresh commands when extensions change (install/uninstall/update).
  const extensionsVersionRef = useRef(
    workspaceEventSignals?.extensionsVersion ?? 0,
  );
  useEffect(() => {
    const current = workspaceEventSignals?.extensionsVersion ?? 0;
    if (current !== extensionsVersionRef.current) {
      extensionsVersionRef.current = current;
      const change = workspaceEventSignals?.lastExtensionChange;
      if (change?.status === 'failed') {
        store.dispatch([
          {
            type: 'error',
            text: t('extensions.action.failed', {
              name: change.name ?? '',
              source: change.source ?? '',
              error: change.error ?? t('error.unknown'),
            }),
          },
        ]);
        return;
      }
      if (change?.status === 'installed') {
        const name = change.name ?? change.source ?? t('extensions.label');
        store.dispatch([
          {
            type: 'status',
            text: change.version
              ? t('extensions.install.installedWithVersion', {
                  name,
                  version: change.version,
                })
              : t('extensions.install.installed', { name }),
          },
        ]);
      } else if (change?.status) {
        const name = change.name ?? change.source ?? t('extensions.label');
        const key =
          change.status === 'updated' && change.version
            ? 'extensions.manage.updatedWithVersion'
            : `extensions.manage.${change.status}`;
        store.dispatch([
          {
            type: 'status',
            text: t(key, { name, version: change.version ?? '' }),
          },
        ]);
      }
      sessionActions.refreshCommands().catch(() => {
        store.dispatch([
          {
            type: 'error',
            text: t('extensions.commands.refreshFailed'),
          },
        ]);
      });
    }
  }, [
    workspaceEventSignals?.extensionsVersion,
    workspaceEventSignals?.lastExtensionChange,
    sessionActions,
    store,
    t,
  ]);
  const [memoryAddScope, setMemoryAddScope] = useState<'workspace' | 'global'>(
    'workspace',
  );
  const [agentsDialogMode, setAgentsDialogMode] =
    useState<AgentsInitialMode | null>(null);
  const [escapeHintVisible, setEscapeHintVisible] = useState(false);
  // Whether the first Esc has armed a stream cancellation; the composer's send
  // button shows an "Esc again to stop" affordance while true.
  const [cancelArmed, setCancelArmed] = useState(false);
  // Which action the pending second Esc would perform, or null when idle.
  const escArmedActionRef = useRef<'cancel' | 'clear' | null>(null);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tasksDialogMessage, setTasksDialogMessage] =
    useState<SerializedTasksMessage | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<WebShellTheme>(
    providedTheme ?? WebShellThemeId.Dark,
  );
  const [currentModel, setCurrentModel] = useState('');
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const setPendingModel = useCallback((modelId: string) => {
    currentModelRef.current = modelId;
    setCurrentModel(modelId);
  }, []);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const requireActiveSessionForLocalCommand = useCallback((): boolean => {
    if (connectionRef.current.sessionId) return true;
    pushToast('info', t('localCommand.noSession'));
    return false;
  }, [pushToast, t]);
  const sessionDisplayName = connection.displayName;
  const [currentMode, setCurrentMode] = useState('default');
  const currentModeRef = useRef(currentMode);
  currentModeRef.current = currentMode;
  const setPendingMode = useCallback((modeId: string) => {
    currentModeRef.current = modeId;
    setCurrentMode(modeId);
  }, []);
  const [isPreparingPrompt, setIsPreparingPrompt] = useState(false);
  const createSessionPromiseRef = useRef<Promise<void> | null>(null);
  const preparingSessionIdRef = useRef<string | null>(null);
  /** Worktree request for the next lazily-created session. */
  const pendingWorktreeRef = useRef<{ slug?: string } | undefined>(undefined);
  /** Render-visible mirror of pendingWorktreeRef for the empty-state badge. */
  const [worktreePending, setWorktreePending] = useState(false);
  const newSessionSuggestionSubmitTokenRef = useRef(0);
  const pendingNewSessionSuggestionSubmitRef = useRef<{
    token: number;
    sourceSessionId: string | undefined;
    sessionClearCompleted: boolean;
    submitScheduled: boolean;
  } | null>(null);
  const onSessionCreatedRef = useRef(onSessionCreated);
  onSessionCreatedRef.current = onSessionCreated;
  /**
   * The session a failed `/goal` submit left behind.
   *
   * Setting a goal starts a fresh session and then sends `/goal <condition>`
   * into it, but the daemon session is not created by the "new session" step —
   * `ensureSessionForPrompt` creates it lazily *inside* `sendPrompt`. So a
   * prompt that fails leaves a session that exists but never got its goal.
   *
   * The Goals form keeps the condition and lets the user retry. Without this
   * ref every retry would abandon that session and create another, piling up
   * blank chats in the sidebar. Remembering it lets the retry reuse it — no
   * session is ever deleted.
   *
   * Only valid while the Goals page stays mounted. The moment the user leaves,
   * that session is reachable from the composer and may stop being a scratch
   * session, so the effect below forgets it: a later goal then starts a fresh
   * session rather than landing on top of a conversation.
   */
  const strandedGoalSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mainView !== 'goals') {
      strandedGoalSessionRef.current = undefined;
    }
  }, [mainView]);
  const ensureSessionForPrompt = useCallback(() => {
    const currentSessionId = connectionRef.current.sessionId;
    if (createSessionPromiseRef.current) {
      if (
        !currentSessionId ||
        currentSessionId === preparingSessionIdRef.current
      ) {
        return createSessionPromiseRef.current;
      }
      return Promise.resolve();
    }
    if (currentSessionId) return Promise.resolve();
    const promise = (async () => {
      const modelId =
        currentModelRef.current || connectionRef.current.currentModel;
      const modeId =
        currentModeRef.current || connectionRef.current.currentMode;
      const primaryWorkspaceCwd = workspaces.find(
        (entry) => entry.primary,
      )?.cwd;
      await createAndAttachSessionForPrompt({
        sessionActions: sessionActions as typeof sessionActions &
          SessionActionsWithCreate,
        modelId,
        modeId,
        workspaceCwd:
          lockedWorkspaceCwd ??
          selectedWorkspaceCwdRef.current ??
          primaryWorkspaceCwd,
        worktree: pendingWorktreeRef.current,
        onSessionCreated: onSessionCreatedRef.current,
        onSessionAllocated: (sessionId) => {
          preparingSessionIdRef.current = sessionId;
        },
        getCurrentSessionId: () => connectionRef.current.sessionId,
      }).then((result) => {
        if (result.worktree) {
          setSessionWorktree(result.worktree);
        }
        // Clear the pending intent only on success. On failure the
        // welcome badge stays visible so the user knows the isolation
        // intent was not fulfilled and can retry.
        pendingWorktreeRef.current = undefined;
        setWorktreePending(false);
      });
      // One-shot: the picker targets only the *next* new session, so clear
      // it after creation. The next new chat defaults back to the primary
      // workspace unless the user picks one again.
      setSelectedWorkspaceCwd(undefined);
    })();
    createSessionPromiseRef.current = promise;
    const clearPreparation = () => {
      if (createSessionPromiseRef.current === promise) {
        createSessionPromiseRef.current = null;
        preparingSessionIdRef.current = null;
      }
    };
    void promise.then(clearPreparation, clearPreparation);
    return promise;
  }, [lockedWorkspaceCwd, sessionActions, workspaces]);
  const onSubmitBeforeRef = useRef(onSubmitBefore);
  onSubmitBeforeRef.current = onSubmitBefore;
  const onSlashCommandRef = useRef(onSlashCommand);
  onSlashCommandRef.current = onSlashCommand;
  const [sessionListReloadToken, setSessionListReloadToken] = useState(0);
  const delayedReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(
    () => () => {
      if (delayedReloadTimerRef.current !== null) {
        clearTimeout(delayedReloadTimerRef.current);
      }
    },
    [],
  );
  const dispatchSessionChange = useCallback(
    (event: SessionChangeEvent) => {
      onSessionChange?.(event);
      setSessionListReloadToken((n) => n + 1);
    },
    [onSessionChange],
  );
  // Ref-stable handle so that useCallback hooks (sendPrompt, enqueuePrompt,
  // turn_complete effect) don't need dispatchSessionChange in their dep arrays.
  // Without this, an unstable onSessionChange prop would cause those callbacks
  // to be recreated on every render, cascading into downstream effect chains.
  const dispatchSessionChangeRef = useRef(dispatchSessionChange);
  dispatchSessionChangeRef.current = dispatchSessionChange;
  const sendPrompt = useCallback(
    async (
      text: string,
      images?: PromptImage[],
      opts?: {
        optimisticUserMessage?: boolean;
        retry?: boolean;
        inputAnnotations?: DaemonInputAnnotation[];
        clearComposerOnPromptStart?: boolean;
        commitComposerAccepted?: ComposerSubmitCommit;
        onAdmitted?: () => void;
      },
    ) => {
      const isUserPrompt = !text.trimStart().startsWith('/');
      const previousLastSubmittedPrompt = lastSubmittedPromptRef.current;
      const previousLastSubmittedImages = lastSubmittedImagesRef.current;
      const previousRetriedTurnErrorId = retriedTurnErrorIdRef.current;
      const previousShowRetryHint = showRetryHintRef.current;
      if (!opts?.retry && isUserPrompt) {
        lastSubmittedPromptRef.current = text;
        lastSubmittedImagesRef.current = images;
        retriedTurnErrorIdRef.current = null;
      }
      setShowRetryHint(false);
      const shouldShowPreparing = !connectionRef.current.sessionId;
      if (onSubmitBeforeRef.current) {
        setIsPreparingPrompt(true);
        try {
          await onSubmitBeforeRef.current({
            sessionId: connectionRef.current.sessionId,
            prompt: text,
          });
        } catch (err) {
          console.warn(
            '[web-shell] onSubmitBefore rejected, prompt cancelled',
            err,
          );
          setIsPreparingPrompt(false);
          // Restore retry-critical refs so Ctrl+Y doesn't resend the
          // cancelled prompt.
          lastSubmittedPromptRef.current = previousLastSubmittedPrompt;
          lastSubmittedImagesRef.current = previousLastSubmittedImages;
          retriedTurnErrorIdRef.current = previousRetriedTurnErrorId;
          setShowRetryHint(previousShowRetryHint);
          return;
        }
        // Only reset if session already exists; otherwise keep true and let
        // ensureSessionForPrompt's finally block handle it.
        if (!shouldShowPreparing) {
          setIsPreparingPrompt(false);
        }
      }
      if (!onSubmitBeforeRef.current && shouldShowPreparing) {
        setIsPreparingPrompt(true);
      }
      clearFollowup();
      try {
        await ensureSessionForPrompt();
      } finally {
        if (shouldShowPreparing) {
          setIsPreparingPrompt(false);
        }
      }
      const promptOptions: SendPromptOptionsWithRetry = {
        images,
        inputAnnotations: opts?.inputAnnotations,
        optimisticUserMessage: opts?.optimisticUserMessage,
        retry: opts?.retry,
        ...(opts?.onAdmitted ? { onAdmitted: opts.onAdmitted } : {}),
      };
      if (opts?.commitComposerAccepted) {
        opts.commitComposerAccepted();
      } else if (opts?.clearComposerOnPromptStart) {
        editorRef.current?.clear();
      }
      const sessionIdAfterEnsure = connectionRef.current.sessionId;
      if (sessionIdAfterEnsure && text.trim()) {
        dispatchSessionChangeRef.current?.({
          type: 'submit',
          sessionId: sessionIdAfterEnsure,
          prompt: text,
          queued: false,
        });
        // Schedule an additional delayed reload to account for daemon-side
        // session registration lag — the immediate reload above may return
        // a list that doesn't yet include the newly created session.
        if (delayedReloadTimerRef.current !== null) {
          clearTimeout(delayedReloadTimerRef.current);
        }
        delayedReloadTimerRef.current = setTimeout(() => {
          setSessionListReloadToken((n) => n + 1);
        }, 2000);
      }
      const result = await (
        sessionActions.sendPrompt as (
          promptText: string,
          options?: SendPromptOptionsWithRetry,
        ) => ReturnType<typeof sessionActions.sendPrompt>
      )(text, promptOptions);
      return result;
    },
    [clearFollowup, ensureSessionForPrompt, sessionActions],
  );
  const availableModels = useMemo(
    () =>
      (connection.models ?? []).filter(isVisibleComposerModel).map((m) => ({
        id: m.id,
        label: getModelDisplayName(m.label || m.id),
      })),
    [connection.models],
  );
  // The workspace the Changes dialog reads — the same active workspace the
  // git-status effect targets (computed once above), so the chip and the
  // dialog always target the same repo.
  const gitDiffWorkspaceCwd = activeWorkspaceCwd;
  const dialogOpen =
    showResumeDialog ||
    showDeleteDialog ||
    showReleaseDialog ||
    showRewindDialog ||
    showHelpDialog ||
    showThemeDialog ||
    showToolsDialog ||
    gitDialog !== undefined ||
    modelDialogMode !== null ||
    showApprovalModeDialog ||
    tasksDialogMessage !== null ||
    mcpDialogMessage !== null ||
    agentsDialogMode !== null ||
    showMemoryDialog ||
    showAuthDialog ||
    externalInteractionBlockCount > 0 ||
    // The Settings / Daemon Status panel replaces the chat surface, so — like a
    // modal — it must suppress chat-only global shortcuts (Ctrl+L/O/Y, the
    // Shift+Tab mode cycle, the btw hotkey). Escape is intercepted earlier and
    // returns to the chat instead of falling through to those handlers.
    activePanel !== null;
  // Block chat interaction (composer, chat keyboard shortcuts) both when a modal
  // is open (dialogOpen, which already includes the Settings/Status panel) and
  // while a full-pane view (the Scheduled Tasks page) covers the chat, so
  // keystrokes/Escape can't reach the hidden composer underneath.
  const interactionBlocked = dialogOpen || mainView !== 'chat';

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      if (isAbortError(error)) return;
      if (isDaemonTurnError(error)) {
        return;
      }
      if (isAlreadyDispatched(error)) {
        return;
      }
      const message = formatError(error, fallback);
      console.error('[web-shell]', message, error);
      pushToast('error', message);
    },
    [pushToast],
  );
  const notifySuccess = useCallback(
    (message: string) => pushToast('success', message),
    [pushToast],
  );

  const {
    queuedPrompts,
    queuedTexts,
    enqueuePrompt: rawEnqueuePrompt,
    removeQueuedPrompt,
    insertQueuedPrompt,
    editQueuedPrompt,
    editLastQueuedPrompt,
    clearQueuedPrompts,
  } = useQueuedPrompts({
    connected,
    sessionId: connection.sessionId,
    clientId: connection.clientId,
    streamingState,
    sessionActions,
    store,
    editorRef,
    reportError,
    notifySuccess,
    t,
  });

  const enqueuePrompt = useCallback(
    (
      text: string,
      images?: PromptImage[],
      onComplete?: () => void,
      commitComposerAccepted?: ComposerSubmitCommit,
      inputAnnotations?: DaemonInputAnnotation[],
    ) => {
      if (onSubmitBeforeRef.current) {
        onSubmitBeforeRef
          .current({
            sessionId: connectionRef.current.sessionId,
            prompt: text,
          })
          .then(() => {
            const result = rawEnqueuePrompt(
              text,
              images,
              onComplete,
              inputAnnotations,
            );
            if (result !== false) {
              if (commitComposerAccepted) {
                commitComposerAccepted();
              } else {
                editorRef.current?.clear();
              }
            }
            const sessionId = connectionRef.current.sessionId;
            if (sessionId && text.trim()) {
              dispatchSessionChangeRef.current?.({
                type: 'submit',
                sessionId,
                prompt: text,
                queued: true,
              });
            }
          })
          .catch((err: unknown) => {
            console.warn(
              '[web-shell] onSubmitBefore rejected queued prompt, cancelled',
              err,
            );
          });
        return false;
      }
      const result = rawEnqueuePrompt(
        text,
        images,
        onComplete,
        inputAnnotations,
      );
      const sessionId = connectionRef.current.sessionId;
      if (sessionId && text.trim()) {
        dispatchSessionChangeRef.current?.({
          type: 'submit',
          sessionId,
          prompt: text,
          queued: true,
        });
      }
      return result;
    },
    [rawEnqueuePrompt],
  );

  useEffect(() => {
    for (const notice of notices) {
      if (shouldToastNotice(notice)) {
        pushToast(toastToneFromNotice(notice), notice.message);
      } else if (notice.category !== 'lifecycle') {
        console.warn('[web-shell] daemon notice', notice);
      }
      dismissNotice(notice.id);
    }
  }, [dismissNotice, notices, pushToast]);

  const onBugReportRef = useRef(onBugReport);
  onBugReportRef.current = onBugReport;

  useEffect(() => {
    currentSessionIdRef.current = connection.sessionId;
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setRecapMessage(null);
    setBtwMessage(null);
    setTasksDialogMessage(null);
    lastRecapBlockCountRef.current = 0;
  }, [connection.sessionId]);

  const runVisibleRecap = useCallback(() => {
    if (!requireActiveSessionForLocalCommand()) return;
    const messageId = `local-recap-${nextRecapMessageIdRef.current++}`;
    const anchorIndex = messages.length;
    const anchorAfterId = messages.at(-1)?.id;
    const sessionId = connection.sessionId;
    setRecapMessage({
      anchorAfterId,
      anchorIndex,
      message: {
        id: messageId,
        role: 'system',
        content: `※ ${t('recap.label')}: ${t('recap.loading')}`,
        variant: 'info',
        source: 'recap',
      },
    });
    sessionActions.recapSession().then(
      (result) => {
        if (currentSessionIdRef.current !== sessionId) return;
        setRecapMessage({
          anchorAfterId,
          anchorIndex,
          message: {
            id: messageId,
            role: 'system',
            content: result.recap
              ? `※ ${t('recap.label')}: ${result.recap}`
              : t('recap.empty'),
            variant: 'info',
            source: 'recap',
          },
        });
      },
      (error: unknown) => {
        if (currentSessionIdRef.current !== sessionId) return;
        setRecapMessage(null);
        if (!isAbortError(error) && !isAlreadyDispatched(error)) {
          console.warn('[web-shell] unhandled recap failure', error);
        }
      },
    );
  }, [
    connection.sessionId,
    messages,
    requireActiveSessionForLocalCommand,
    sessionActions,
    t,
  ]);

  const runVisibleBtw = useCallback(
    (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question) {
        pushToast('error', t('btw.empty'));
        return;
      }
      if (!requireActiveSessionForLocalCommand()) return;

      const messageId = `local-btw-${nextBtwMessageIdRef.current++}`;
      const sessionId = connection.sessionId;
      btwAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      btwAbortControllerRef.current = abortController;
      setBtwMessage({
        id: messageId,
        role: 'btw',
        question,
        answer: '',
        isPending: true,
      });

      sessionActions
        .btwSession(question, { signal: abortController.signal })
        .then(
          (result) => {
            if (currentSessionIdRef.current !== sessionId) return;
            if (btwAbortControllerRef.current !== abortController) return;
            btwAbortControllerRef.current = null;
            setBtwMessage({
              id: messageId,
              role: 'btw',
              question,
              answer: result.answer || t('btw.emptyAnswer'),
              isPending: false,
            });
          },
          (error: unknown) => {
            if (currentSessionIdRef.current !== sessionId) return;
            if (btwAbortControllerRef.current !== abortController) return;
            btwAbortControllerRef.current = null;
            setBtwMessage(null);
            if (!isAbortError(error) && !isAlreadyDispatched(error)) {
              console.warn('[web-shell] unhandled btw failure', error);
            }
          },
        );
    },
    [
      connection.sessionId,
      pushToast,
      requireActiveSessionForLocalCommand,
      sessionActions,
      t,
    ],
  );

  const dismissBtwMessage = useCallback(() => {
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setBtwMessage(null);
  }, []);

  useEffect(() => {
    const onBtwShortcut = (e: KeyboardEvent) => {
      if (interactionBlocked || pendingApproval) return;
      const message = btwMessage;
      if (!message || message.role !== 'btw') return;

      const key = e.key.toLowerCase();
      const isPlainEscape =
        e.key === 'Escape' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey;
      const isCtrlCancel =
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey &&
        (key === 'c' || key === 'd');

      if (message.isPending) {
        if (!isPlainEscape && !isCtrlCancel) return;
      } else {
        const editorHasText = editorRef.current?.hasInput() ?? false;
        const isPlainDismiss =
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          !e.shiftKey &&
          (e.key === 'Escape' ||
            (!editorHasText && (e.key === 'Enter' || e.key === ' ')));
        if (!isPlainDismiss) return;
      }

      e.preventDefault();
      e.stopPropagation();
      dismissBtwMessage();
    };

    window.addEventListener('keydown', onBtwShortcut, true);
    return () => window.removeEventListener('keydown', onBtwShortcut, true);
  }, [interactionBlocked, btwMessage, dismissBtwMessage, pendingApproval]);

  // Echo a local command into the transcript, or suppress it while a turn is
  // streaming so the injected user row can't split the active turn (see
  // appendOrDeferLocalUserMessage). Returns true when suppressed — callers must
  // then stop and not run the command's inline side effects.
  const echoOrDeferLocalCommand = useCallback(
    (text: string, images?: PromptImage[]): boolean =>
      appendOrDeferLocalUserMessage(
        streamingStateRef.current !== 'idle',
        text,
        images,
        {
          append: (value: string) => store.appendLocalUserMessage(value),
        },
      ),
    [store],
  );

  const blockLocalCommandDuringTurn = useCallback((): false => {
    pushToast('error', t('queue.commandBlocked'));
    return false;
  }, [pushToast, t]);

  const handleThemeChange = useCallback(
    (nextTheme: WebShellTheme) => {
      setSelectedTheme(nextTheme);
      onThemeChange?.(nextTheme);
    },
    [onThemeChange],
  );

  const handleLanguageChange = useCallback(
    (nextLanguage: WebShellLanguage) => {
      setSelectedLanguage(nextLanguage);
      onLanguageChange?.(nextLanguage);
    },
    [onLanguageChange],
  );

  const handleToggleShortcuts = useCallback(() => {
    setShowHelpDialog(true);
  }, []);

  const workspaceSettingsState = useSettings({
    autoLoad: true,
  });
  const providersState = useProviders({ autoLoad: true });
  // useProviders returns a fresh object each render, but its `reload` identity is
  // stable — pull it out so callbacks can depend on the function alone without
  // re-creating on every render (and without an exhaustive-deps warning).
  const reloadProviders = providersState.reload;
  const [modelActionBusy, setModelActionBusy] = useState(false);
  const {
    settings: workspaceSettings,
    setValue: setWorkspaceSetting,
    reload: reloadWorkspaceSettings,
  } = workspaceSettingsState;
  const themeSetting = workspaceSettings.find(
    (setting) => setting.key === THEME_SETTING_KEY,
  );
  const hideTipsSetting = workspaceSettings.find(
    (setting) => setting.key === HIDE_TIPS_SETTING_KEY,
  );
  const languageSetting = workspaceSettings.find(
    (setting) => setting.key === LANGUAGE_SETTING_KEY,
  );
  const currentVoiceModel = (() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'voiceModel',
    );
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
  const currentVisionModel = (() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'visionModel',
    );
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return decodeVisionModelForPicker(value.trim());
  })();
  const currentFastModel = (() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'fastModel',
    );
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
  const currentModelFallbacks = useMemo(() => {
    const value = readScopedModelSetting(
      workspaceSettings,
      modelSettingScope,
      'modelFallbacks',
    );
    return typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  }, [workspaceSettings, modelSettingScope]);
  // Fallback candidates are the selectable (non-runtime) models, keyed by their
  // base id — the same value shape the modelFallbacks setting stores.
  const fallbackModelOptions = useMemo(() => {
    // modelFallbacks stores bare ids and the dialog keys rows by baseId, so
    // dedupe here — multiple endpoints can expose the same base model id.
    const seen = new Set<string>();
    const options: Array<{ baseId: string; label: string }> = [];
    for (const m of (connection.models ?? [])
      .filter(isVisibleComposerModel)
      .filter((m) => !m.isRuntime)) {
      const baseId = m.baseModelId ?? extractBareModelId(m.id);
      if (seen.has(baseId)) continue;
      seen.add(baseId);
      options.push({
        baseId,
        label: getModelDisplayName(m.label || m.baseModelId || m.id),
      });
    }
    return options;
  }, [connection.models]);
  const [compactMode, setCompactMode] = useState(false);
  const compactModeRef = useRef(compactMode);
  compactModeRef.current = compactMode;

  useEffect(() => {
    if (providedTheme) {
      setSelectedTheme(providedTheme);
      return;
    }
    const settingTheme = themeSettingToWebShellTheme(
      themeSetting?.values.effective,
    );
    if (settingTheme) {
      setSelectedTheme(settingTheme);
    }
  }, [providedTheme, themeSetting?.values.effective]);

  useEffect(() => {
    if (providedLanguage !== undefined) {
      setSelectedLanguage(normalizeLanguage(providedLanguage));
      return;
    }
    const settingLanguage = languageSettingToWebShellLanguage(
      languageSetting?.values.effective,
    );
    if (settingLanguage) {
      setSelectedLanguage(settingLanguage);
    }
  }, [providedLanguage, languageSetting?.values.effective]);

  const handleSettingsLanguageChange = useCallback(
    (nextLanguage: WebShellLanguage, scope: 'user' | 'workspace' = 'user') => {
      const previousLanguage = selectedLanguage;
      // Forward the settings tab's scope to the command so a Workspace-tab edit
      // persists to workspace settings instead of always writing user scope
      // (the /language command otherwise defaults to user). The command still
      // switches the daemon's live locale so command descriptions re-localize —
      // which a plain scoped settings write wouldn't do.
      const scopeFlag = scope === 'workspace' ? ' --project' : ' --global';
      const command = `/language ui ${nextLanguage}${scopeFlag}`;
      handleLanguageChange(nextLanguage);
      const refreshSettings = () => {
        return Promise.all([
          sessionActions.refreshCommands(),
          reloadWorkspaceSettings(),
        ]);
      };
      if (streamingStateRef.current !== 'idle') {
        handleLanguageChange(previousLanguage);
        blockLocalCommandDuringTurn();
        return;
      }
      sendPrompt(command, undefined)
        .then(refreshSettings)
        .catch((error: unknown) => {
          handleLanguageChange(previousLanguage);
          reportError(error, 'Failed to sync /language command');
        });
    },
    [
      blockLocalCommandDuringTurn,
      handleLanguageChange,
      reloadWorkspaceSettings,
      reportError,
      sendPrompt,
      selectedLanguage,
      sessionActions,
    ],
  );

  const handleClearScreen = useCallback(() => {
    if (streamingStateRef.current !== 'idle') {
      store.dispatch([{ type: 'status', text: t('clear.blocked') }]);
      return;
    }
    store.reset();
  }, [store, t]);

  const handleToggleCompact = useCallback(() => {
    const previous = compactModeRef.current;
    const next = !compactModeRef.current;
    setCompactMode(next);
    setWorkspaceSetting('workspace', COMPACT_MODE_SETTING_KEY, next).catch(
      (error: unknown) => {
        setCompactMode(previous);
        reportError(error, t('compact.saveFailed'));
      },
    );
  }, [reportError, setWorkspaceSetting, t]);

  const handleSetMode = useCallback(
    (modeId: string) => {
      if (!isDaemonApprovalMode(modeId)) {
        reportError(
          new Error(`Unsupported approval mode: ${modeId}`),
          t('local.approvalMode'),
        );
        return;
      }
      if (!connectionRef.current.sessionId) {
        setPendingMode(modeId);
        return;
      }
      sessionActions
        .setApprovalMode(modeId)
        .then((result) => {
          const effectiveMode = result.mode || modeId;
          setCurrentMode(effectiveMode);
          const approval = pendingApprovalRef.current;
          if (!approval) return;
          const shouldAutoApprove =
            modeId === 'yolo' ||
            (modeId === 'auto-edit' && isEditToolPermission(approval));
          if (shouldAutoApprove) {
            const allowOnce = approval.options.find(
              (o) => o.kind === 'allow_once',
            );
            if (allowOnce) {
              const toolDesc = approval.title || '';
              store.dispatch([
                {
                  type: 'status',
                  text: t('mode.autoApproved', { tool: toolDesc }),
                },
              ]);
              sessionActions
                .submitPermission(approval.id, allowOnce.id)
                .catch((error: unknown) => {
                  reportError(error, 'Failed to auto-approve tool call');
                });
            }
          }
        })
        .catch((error: unknown) => {
          reportError(error, t('local.approvalMode'));
        });
    },
    [sessionActions, reportError, store, t, setPendingMode],
  );

  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

  useEffect(() => {
    modelDialogModeRef.current = modelDialogMode;
    showFallbacksDialogRef.current = showFallbacksDialog;
    showAuthDialogRef.current = showAuthDialog;
  }, [modelDialogMode, showFallbacksDialog, showAuthDialog]);

  useEffect(() => {
    let retryableTurnErrorId: string | null = null;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block?.kind === 'user') break;
      if (block?.kind === 'error' && block.source === 'turn_error') {
        retryableTurnErrorId = block.id;
        break;
      }
      if (block?.kind !== 'debug') break;
    }
    const canRetry =
      connected &&
      retryableTurnErrorId !== null &&
      retryableTurnErrorId !== retriedTurnErrorIdRef.current &&
      lastSubmittedPromptRef.current.length > 0;
    retryableTurnErrorIdRef.current = canRetry ? retryableTurnErrorId : null;
    setShowRetryHint(canRetry);
  }, [blocks, connected]);

  useEffect(() => {
    onStreamingStateChange?.(streamingState);
  }, [streamingState, onStreamingStateChange]);

  // Reads retryableTurnErrorIdRef which is set by the blocks effect above.
  // Declaration order matters: this effect must run after the blocks effect
  // so that within the same render, the ref is already updated before we read it.
  const prevStreamingForTurnCompleteRef = useRef(streamingState);
  const streamingSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStreamingForTurnCompleteRef.current;
    prevStreamingForTurnCompleteRef.current = streamingState;
    if (streamingState !== 'idle') {
      streamingSessionIdRef.current = connectionRef.current.sessionId;
    }
    if (prev !== 'idle' && streamingState === 'idle') {
      const sessionId = connectionRef.current.sessionId;
      // Only fire if the session that was streaming is still the active one.
      // Session switches reset streamingState to idle, which must not produce
      // a spurious turn_complete for the new session.
      if (!sessionId || sessionId !== streamingSessionIdRef.current) return;
      const turnError =
        retryableTurnErrorIdRef.current != null
          ? new Error(`Turn error (block ${retryableTurnErrorIdRef.current})`)
          : undefined;
      dispatchSessionChangeRef.current?.({
        type: 'turn_complete',
        sessionId,
        error: turnError,
      });
    }
  }, [streamingState]);

  useEffect(() => {
    onConnectionChange?.(connection.status);
  }, [connection.status, onConnectionChange]);

  useEffect(() => {
    onTranscriptChange?.(blocks);
  }, [blocks, onTranscriptChange]);

  useEffect(() => {
    if (connection.error) {
      const error = new Error(connection.error);
      onError?.(error);
    }
  }, [connection.error, onError]);

  useEffect(() => {
    setCurrentModel(connection.currentModel ?? '');
  }, [connection.currentModel, connection.sessionId]);

  useEffect(() => {
    setCurrentMode(connection.currentMode ?? 'default');
  }, [connection.currentMode, connection.sessionId]);

  useEffect(() => {
    const previousGoalSessionId = lastGoalSessionIdRef.current;
    if (
      connection.sessionId &&
      connection.sessionId !== previousGoalSessionId
    ) {
      setActiveGoal(null);
    }
    lastGoalSessionIdRef.current = connection.sessionId;
    if (!connection.sessionId && connection.missingSession) {
      // Keep the dead-session route visible until the user explicitly starts a
      // new chat; clearing it here would immediately hide the recovery state.
      lastNotifiedSessionIdRef.current = connection.sessionId;
      lastNotifiedWorkspaceIdRef.current = undefined;
      lastNotifiedWorkspaceCwdRef.current = undefined;
      return;
    }
    const activeWorkspace = workspaces.find(
      (entry) => entry.cwd === connection.workspaceCwd,
    );
    if (connection.sessionId && !workspace.capabilities) return;
    const workspaceId =
      activeWorkspace && !activeWorkspace.primary
        ? activeWorkspace.id
        : undefined;
    if (
      lastNotifiedSessionIdRef.current === connection.sessionId &&
      lastNotifiedWorkspaceIdRef.current === workspaceId &&
      lastNotifiedWorkspaceCwdRef.current === connection.workspaceCwd
    ) {
      return;
    }
    lastNotifiedSessionIdRef.current = connection.sessionId;
    lastNotifiedWorkspaceIdRef.current = workspaceId;
    lastNotifiedWorkspaceCwdRef.current = connection.workspaceCwd;
    onSessionIdChange?.(
      connection.sessionId,
      workspaceId,
      connection.workspaceCwd,
    );
  }, [
    connection.missingSession,
    connection.sessionId,
    connection.workspaceCwd,
    onSessionIdChange,
    workspace.capabilities,
    workspaces,
  ]);

  const lastRenameSessionRef = useRef<string | undefined>(undefined);
  const lastRenameNameRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sessionId = connection.sessionId;
    const displayName = connection.displayName;
    if (!sessionId || !displayName) return;
    if (sessionId !== lastRenameSessionRef.current) {
      lastRenameSessionRef.current = sessionId;
      lastRenameNameRef.current = displayName;
      return;
    }
    if (displayName === lastRenameNameRef.current) return;
    lastRenameNameRef.current = displayName;
    dispatchSessionChangeRef.current?.({
      type: 'rename',
      sessionId,
      newName: displayName,
    });
  }, [connection.sessionId, connection.displayName]);

  useEffect(() => {
    const nextGoal = getLatestActiveGoalFromBlocks(blocks);
    setActiveGoal((current) => {
      if (!nextGoal) return current ? null : current;
      if (
        current?.condition === nextGoal.condition &&
        current.setAt === nextGoal.setAt
      ) {
        return current;
      }
      return nextGoal;
    });
  }, [blocks]);

  useEffect(() => {
    const onGoalStatusActive = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          active?: boolean;
          condition?: string;
          setAt?: number;
        }>
      ).detail;
      if (!detail?.active) {
        setActiveGoal(null);
        return;
      }
      if (!detail.condition) return;
      setActiveGoal({
        condition: detail.condition,
        setAt: detail.setAt ?? Date.now(),
      });
    };

    window.addEventListener(GOAL_STATUS_ACTIVE_EVENT, onGoalStatusActive);
    return () =>
      window.removeEventListener(GOAL_STATUS_ACTIVE_EVENT, onGoalStatusActive);
  }, []);

  // Auto-recap: fire when the user returns after being away ≥ 3 minutes
  const hiddenAtRef = useRef<number | null>(null);
  const lastRecapBlockCountRef = useRef(0);
  useEffect(() => {
    lastRecapBlockCountRef.current = 0;
  }, [connection.sessionId]);
  useEffect(() => {
    const AWAY_THRESHOLD_MS = 3 * 60 * 1000;
    const MIN_NEW_BLOCKS = 4;
    function onVisibilityChange() {
      if (document.hidden) {
        if (hiddenAtRef.current === null) hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt === null) return;
      if (Date.now() - hiddenAt < AWAY_THRESHOLD_MS) return;
      if (streamingStateRef.current !== 'idle') return;
      if (!connection.sessionId) return;
      const currentCount = store.getSnapshot().blocks.length;
      if (currentCount - lastRecapBlockCountRef.current < MIN_NEW_BLOCKS)
        return;
      lastRecapBlockCountRef.current = currentCount;
      sessionActions.recapSession().then(
        (result) => {
          if (result.recap) {
            store.dispatch([
              {
                type: 'status',
                text: `※ ${t('recap.label')}: ${result.recap}`,
                source: 'recap',
              },
            ]);
          }
        },
        (error: unknown) => {
          console.error('[auto-recap] failed:', error);
        },
      );
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [connection.sessionId, sessionActions, store, t]);

  const handleCycleMode = useCallback(() => {
    const idx = isDaemonApprovalMode(currentMode)
      ? MODES_CYCLE.indexOf(currentMode)
      : -1;
    const next = MODES_CYCLE[(idx + 1) % MODES_CYCLE.length];
    handleSetMode(next);
  }, [currentMode, handleSetMode]);

  // Shared by the /context slash command and the status-bar context
  // indicator. Echoes the command as a local user message first — that also
  // makes the transcript follow the tail (MessageList Rule 4), so the panel
  // is revealed even when the click comes while scrolled up.
  const showContextUsage = useCallback(
    (commandText: string, detail: boolean) => {
      // Self-guard so every entry point (keyboard, status-bar button, in-chat
      // "context detail" click) defers mid-turn instead of splitting the turn.
      if (!requireActiveSessionForLocalCommand()) return;
      if (echoOrDeferLocalCommand(commandText)) return;
      sessionActions
        .getContextUsage({ detail })
        .then((result) => {
          store.dispatch([
            {
              type: 'status',
              text: serializeContextUsageMessage(result),
            },
          ]);
          resumeChatBottomFollow('smooth');
        })
        .catch((error: unknown) => {
          reportError(error, 'Failed to load context usage');
        });
    },
    [
      echoOrDeferLocalCommand,
      store,
      requireActiveSessionForLocalCommand,
      sessionActions,
      reportError,
      resumeChatBottomFollow,
    ],
  );

  // Stable reference: this travels through the memoized MessageList →
  // MessageItem chain, so an inline closure would defeat their memo.
  const handleShowContextDetail = useCallback(() => {
    showContextUsage('/context detail', true);
  }, [showContextUsage]);

  const branchCurrentSession = useCallback(
    (name?: string) => {
      if (!requireActiveSessionForLocalCommand()) return;
      sessionActions
        .branchSession(name || undefined)
        .then((result) => {
          store.dispatch([
            {
              type: 'status',
              text: t('branch.success', {
                name: result.displayName,
              }),
            },
          ]);
        })
        .catch((error: unknown) => {
          reportError(error, t('branch.failed'));
        });
    },
    [
      reportError,
      requireActiveSessionForLocalCommand,
      sessionActions,
      store,
      t,
    ],
  );
  const handleBranchCurrentSession = useCallback(() => {
    branchCurrentSession();
  }, [branchCurrentSession]);

  const composerFocusRequestRef = useRef(0);
  const scheduleComposerFocus = useCallback((sessionId?: string) => {
    const request = ++composerFocusRequestRef.current;
    window.setTimeout(() => {
      if (
        request !== composerFocusRequestRef.current ||
        approvalOverlayActiveRef.current ||
        (sessionId !== undefined &&
          connectionRef.current.sessionId !== sessionId)
      ) {
        return;
      }
      editorRef.current?.focus();
    }, 0);
    return request;
  }, []);
  const createNewSession = useCallback(
    async (
      workspaceCwd?: string,
      /**
       * Leave `mainView` alone. The default is to switch to the chat, because a
       * user who asks for a new chat wants to see it — but the Goals form has to
       * stay mounted until its prompt is admitted, or a rejection has nowhere to
       * render. Only that caller passes this.
       */
      opts?: { keepView?: boolean },
    ) => {
      const targetWorkspaceCwd = lockedWorkspaceCwd ?? workspaceCwd;
      selectedWorkspaceCwdRef.current = targetWorkspaceCwd;
      setSelectedWorkspaceCwd(targetWorkspaceCwd);
      // Starting a fresh chat drops any pending worktree intent set from the
      // empty-state toggle, so it never leaks into the next created session.
      pendingWorktreeRef.current = undefined;
      setWorktreePending(false);
      // Close the drawer before awaiting so a failed createSession() doesn't leave
      // it stuck open with the page scroll still locked, matching loadSidebarSession.
      closeMobileDrawer();
      // Starting a new chat means the user wants to see it — leave any open
      // Settings/Status panel so the fresh chat is visible (no-op when closed).
      closePanel();
      if (!opts?.keepView) setMainView('chat');
      let focusRequest: number | undefined;
      try {
        const clearPromise = (
          sessionActions as typeof sessionActions & SessionActionsWithCreate
        ).clearSession();
        focusRequest = scheduleComposerFocus();
        await Promise.all([
          clearPromise,
          reloadLoadedSkills(targetWorkspaceCwd),
        ]);
        // Clear after successful clearSession — if it rejects, the old
        // session's worktree state is preserved.
        worktreeGenRef.current += 1;
        setSessionWorktree(undefined);
        return true;
      } catch (error) {
        if (composerFocusRequestRef.current === focusRequest) {
          composerFocusRequestRef.current += 1;
        }
        reportError(error, 'Failed to start a new chat');
        return false;
      }
    },
    [
      closeMobileDrawer,
      closePanel,
      lockedWorkspaceCwd,
      reportError,
      reloadLoadedSkills,
      scheduleComposerFocus,
      sessionActions,
    ],
  );
  useEffect(
    () => () => {
      if (composerTextDebounceRef.current) {
        clearTimeout(composerTextDebounceRef.current);
      }
    },
    [],
  );

  const handleComposerTextChange = useCallback((text: string) => {
    composerTextRef.current = text;
    if (composerTextDebounceRef.current) {
      clearTimeout(composerTextDebounceRef.current);
    }
    composerTextDebounceRef.current = setTimeout(() => {
      setComposerText(text);
      composerTextDebounceRef.current = null;
    }, 120);
  }, []);

  const {
    suggestion: newSessionSuggestion,
    dismiss: dismissNewSessionSuggestion,
    suppress: suppressNewSessionSuggestion,
  } = useNewSessionSuggestion({
    enabled:
      connection.capabilities?.features.includes('session_generation') === true,
    inputText: composerText,
    messages,
    sessionId: connection.sessionId,
    contextUsageRatio:
      (connection.contextWindow ?? 0) > 0
        ? (connection.tokenCount ?? 0) / (connection.contextWindow ?? 0)
        : 0,
    isRunning: streamingState !== 'idle',
    dialogOpen: interactionBlocked || approvalOverlayActive,
    generateContent: sessionActions.generateSessionContent,
  });

  const flushPendingNewSessionSuggestionSubmit = useCallback(
    (expectedToken?: number) => {
      const pending = pendingNewSessionSuggestionSubmitRef.current;
      if (!pending) return;
      if (expectedToken !== undefined && pending.token !== expectedToken)
        return;

      const activeSessionId = connectionRef.current.sessionId;
      if (
        pending.sourceSessionId !== undefined &&
        activeSessionId !== undefined &&
        activeSessionId !== pending.sourceSessionId
      ) {
        pendingNewSessionSuggestionSubmitRef.current = null;
        setIsStartingNewSessionSuggestion(false);
        return;
      }

      if (!pending.sessionClearCompleted) {
        return;
      }

      if (activeSessionId !== undefined) {
        return;
      }

      if (pending.submitScheduled) {
        return;
      }

      pendingNewSessionSuggestionSubmitRef.current = {
        ...pending,
        submitScheduled: true,
      };
      window.setTimeout(() => {
        const latestPending = pendingNewSessionSuggestionSubmitRef.current;
        if (!latestPending || latestPending.token !== pending.token) {
          return;
        }
        if (connectionRef.current.sessionId !== undefined) {
          pendingNewSessionSuggestionSubmitRef.current = null;
          setIsStartingNewSessionSuggestion(false);
          return;
        }
        pendingNewSessionSuggestionSubmitRef.current = null;
        editorRef.current?.submit();
        editorRef.current?.focus();
        setIsStartingNewSessionSuggestion(false);
      }, 0);
    },
    [],
  );

  useEffect(() => {
    flushPendingNewSessionSuggestionSubmit();
  }, [connection.sessionId, flushPendingNewSessionSuggestionSubmit]);

  const handleAcceptNewSessionSuggestion = useCallback(() => {
    const draft = composerTextRef.current.trim();
    if (!draft || isStartingNewSessionSuggestion) return;
    if (newSessionSuggestion?.classifiedInput !== draft) {
      dismissNewSessionSuggestion();
      return;
    }
    suppressNewSessionSuggestion();
    setIsStartingNewSessionSuggestion(true);
    const token = newSessionSuggestionSubmitTokenRef.current + 1;
    newSessionSuggestionSubmitTokenRef.current = token;
    pendingNewSessionSuggestionSubmitRef.current = {
      token,
      sourceSessionId: connectionRef.current.sessionId,
      sessionClearCompleted: false,
      submitScheduled: false,
    };
    void createNewSession().then((created) => {
      const pending = pendingNewSessionSuggestionSubmitRef.current;
      if (!created || pending?.token !== token) {
        if (pending?.token === token) {
          pendingNewSessionSuggestionSubmitRef.current = null;
        }
        setIsStartingNewSessionSuggestion(false);
        return;
      }
      pendingNewSessionSuggestionSubmitRef.current = {
        ...pending,
        sessionClearCompleted: true,
      };
      onSessionIdChange?.(undefined);
      flushPendingNewSessionSuggestionSubmit(token);
    });
  }, [
    createNewSession,
    dismissNewSessionSuggestion,
    flushPendingNewSessionSuggestionSubmit,
    isStartingNewSessionSuggestion,
    newSessionSuggestion,
    onSessionIdChange,
    suppressNewSessionSuggestion,
  ]);

  const shellApi = useMemo<WebShellApi>(
    () => ({
      openSplitView: () => {
        closeMobileDrawer();
        requestOpenSplitView();
      },
      openSessionOverview: () => {
        closeMobileDrawer();
        openPanel('sessions');
      },
      openSessionDrawer,
      createNewSession: () => createNewSession(),
    }),
    [
      closeMobileDrawer,
      createNewSession,
      openPanel,
      openSessionDrawer,
      requestOpenSplitView,
    ],
  );
  useEffect(() => {
    assignShellRef(shellRef, shellApi);
  }, [shellApi, shellRef]);
  useEffect(
    () => () => {
      assignShellRef(shellRef, null);
    },
    [shellRef],
  );
  const handleMissingSessionNewSession = useCallback(async () => {
    if (creatingMissingSessionRef.current) return;
    creatingMissingSessionRef.current = true;
    setIsCreatingMissingSession(true);
    try {
      const success = await createNewSession();
      if (success) {
        onSessionIdChange?.(undefined);
      }
    } finally {
      creatingMissingSessionRef.current = false;
      setIsCreatingMissingSession(false);
    }
  }, [createNewSession, onSessionIdChange]);

  const loadSidebarSession = useCallback(
    async (sessionId: string, workspaceCwd?: string) => {
      composerFocusRequestRef.current += 1;
      setSidebarSwitchingSessionId(sessionId);
      pendingWorktreeRef.current = undefined;
      setWorktreePending(false);
      worktreeGenRef.current += 1;
      setSessionWorktree(undefined);
      // Close the drawer before awaiting the load; the transcript clears
      // immediately and shows its loading skeleton for the selected session.
      closeMobileDrawer();
      // Loading another session should reveal its chat, not stay on the
      // Settings/Status panel (no-op when the panel is closed).
      closePanel();
      try {
        await sessionActions.loadSession(sessionId, { workspaceCwd });
      } catch (error) {
        setSidebarSwitchingSessionId((current) =>
          current === sessionId ? null : current,
        );
        throw error;
      }
    },
    [closeMobileDrawer, closePanel, sessionActions],
  );

  // Clicking a card in the Session Overview panel switches the current window
  // to that session. loadSidebarSession already closes the panel, so this just
  // returns to the chat view and reports load failures.
  const handleOpenSessionFromOverview = useCallback(
    (sessionId: string) => {
      setMainView('chat');
      void loadSidebarSession(sessionId).catch((error: unknown) => {
        reportError(error, 'Failed to open session');
      });
    },
    [loadSidebarSession, reportError],
  );

  // Listen for `qwen:open-session` events dispatched by the markdown renderer
  // when a `qwen-session://<id>` link is clicked. Navigate to the session.
  useEffect(() => {
    const handler = (e: Event) => {
      const sessionId = (e as CustomEvent<string>).detail;
      if (typeof sessionId === 'string' && sessionId) {
        handleOpenSessionFromOverview(sessionId);
      }
    };
    window.addEventListener('qwen:open-session', handler);
    return () => window.removeEventListener('qwen:open-session', handler);
  }, [handleOpenSessionFromOverview]);

  useEffect(() => {
    if (
      sidebarSwitchingSessionId !== null &&
      connection.sessionId === sidebarSwitchingSessionId &&
      !connection.loadingTranscript &&
      !connection.catchingUp
    ) {
      setSidebarSwitchingSessionId(null);
      scheduleComposerFocus(sidebarSwitchingSessionId);
    }
  }, [
    connection.catchingUp,
    connection.loadingTranscript,
    connection.sessionId,
    scheduleComposerFocus,
    sidebarSwitchingSessionId,
  ]);

  // Manual "run now" from the scheduled-tasks page. A bound task runs in its
  // own session (so manual and scheduled runs share one transcript); an unbound
  // task runs in the current session. Switching sessions is async, so a latch
  // holds the prompt until the target session is fully active before sending.
  //
  // Returns a promise that resolves once the prompt is actually ENQUEUED and
  // rejects if the bound session can't be opened (archived/deleted), supersedes,
  // or times out — so the caller only records the run after it truly happened,
  // never on a failed session switch. Only one bound run waits at a time.
  const pendingBoundRunRef = useRef<{
    sessionId: string;
    prompt: string;
    resolve: () => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const clearPendingBoundRun = useCallback((sessionId: string) => {
    const cur = pendingBoundRunRef.current;
    if (cur && cur.sessionId === sessionId) {
      clearTimeout(cur.timer);
      pendingBoundRunRef.current = null;
    }
  }, []);
  // Enqueue a manual-run prompt in the CURRENT session, resolving as soon as the
  // daemon ADMITS it — not when the whole turn finishes. sendPrompt resolves via
  // waitForAcceptedPromptCompletion (turn end), which is too late: a long or
  // permission-blocked run, or a closed tab, would execute in the session but
  // never get recorded. `onAdmitted` fires at submitPrompt acceptance.
  //
  // Deliberately NO pre-admission timeout here. `sendPrompt` isn't abortable, so
  // a timer that rejected while the send was still in flight could let a LATE
  // admission execute the prompt in the session AFTER the caller had already
  // handled the rejection and skipped recording — an unrecorded run the user
  // could retry into a duplicate. Staying tied to admission guarantees any
  // accepted prompt is recorded, and the run controls stay busy (not free to
  // re-fire) until the send admits or settles. The earlier "session never becomes
  // active" phase is still bounded by the switch timeout in runTaskManually. If
  // the send settles WITHOUT admitting (onSubmitBefore cancel) or throws before
  // admission, reject so the caller skips recording a run that never reached the
  // session.
  const enqueueManualRun = useCallback(
    (prompt: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let admitted = false;
        const admit = () => {
          if (admitted) return;
          admitted = true;
          resolve();
        };
        sendPrompt(prompt, undefined, { onAdmitted: admit }).then(
          () => {
            if (!admitted) {
              reject(new Error('Run was cancelled before it started'));
            }
          },
          (error: unknown) => {
            if (!admitted) reject(error);
          },
        );
      }),
    [sendPrompt],
  );
  // Enqueue the pending bound run once its session is the current, fully-loaded
  // one — driven both by the effect below (when the session switch changes a
  // dep) AND directly after loadSidebarSession resolves (when the session was
  // ALREADY active, so no dep changes and the effect never re-runs — otherwise
  // the run would hang until the switch timeout and falsely report a failure).
  // Whoever fires first nulls the latch, so it runs exactly once.
  const tryFireBoundRun = useCallback(() => {
    const pending = pendingBoundRunRef.current;
    const conn = connectionRef.current;
    if (
      !pending ||
      conn.sessionId !== pending.sessionId ||
      conn.loadingTranscript ||
      conn.catchingUp
    ) {
      return;
    }
    clearTimeout(pending.timer);
    pendingBoundRunRef.current = null;
    // Resolves at prompt admission (see enqueueManualRun); the switch-timeout was
    // cleared above, so a long turn can't trip it. Recording happens in the
    // dialog once this resolves.
    enqueueManualRun(pending.prompt).then(
      () => pending.resolve(),
      (error: unknown) => pending.reject(error),
    );
  }, [enqueueManualRun]);
  const runTaskManually = useCallback(
    (prompt: string, sessionId: string | null): Promise<void> => {
      setMainView('chat');
      if (!sessionId) {
        // Unbound: runs in the current session — resolves at admission.
        return enqueueManualRun(prompt);
      }
      // A newer bound run supersedes an older one still waiting on the latch;
      // reject the old promise so its caller doesn't record a dropped run.
      const prev = pendingBoundRunRef.current;
      if (prev) {
        clearTimeout(prev.timer);
        pendingBoundRunRef.current = null;
        prev.reject(new Error('superseded by another run'));
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          clearPendingBoundRun(sessionId);
          reject(new Error('Timed out switching to the task session'));
        }, BOUND_RUN_SWITCH_TIMEOUT_MS);
        pendingBoundRunRef.current = {
          sessionId,
          prompt,
          resolve,
          reject,
          timer,
        };
        loadSidebarSession(sessionId)
          // Fire immediately when the session was already active (no dep change
          // to trigger the effect); a no-op if the load is still settling, in
          // which case the effect picks it up.
          .then(() => tryFireBoundRun())
          .catch((error: unknown) => {
            clearPendingBoundRun(sessionId);
            reject(error);
          });
      });
    },
    [
      enqueueManualRun,
      loadSidebarSession,
      clearPendingBoundRun,
      tryFireBoundRun,
    ],
  );
  useEffect(() => {
    tryFireBoundRun();
  }, [
    connection.sessionId,
    connection.loadingTranscript,
    connection.catchingUp,
    tryFireBoundRun,
  ]);

  const openTasksPanel = useCallback(() => {
    if (!requireActiveSessionForLocalCommand()) return;
    sessionActions
      .getTasks()
      .then((snapshot) => {
        setTasksDialogMessage({ snapshot });
      })
      .catch((error: unknown) => {
        reportError(error, 'Failed to load tasks');
      });
  }, [reportError, requireActiveSessionForLocalCommand, sessionActions]);

  const dispatchGoalSet = useCallback(
    (condition: string, setAt: number) => {
      setActiveGoal({ condition, setAt });
      store.dispatch([
        {
          type: 'status',
          text: serializeGoalStatusMessage({
            kind: 'set',
            condition,
            setAt,
          }),
        },
      ]);
    },
    [store],
  );

  const dispatchGoalCleared = useCallback(
    (goal: ActiveGoalStatus | null) => {
      if (!goal) return;
      store.dispatch([
        {
          type: 'status',
          text: serializeGoalStatusMessage({
            kind: 'cleared',
            condition: goal.condition,
            durationMs: Date.now() - goal.setAt,
          }),
        },
      ]);
      setActiveGoal(null);
    },
    [store],
  );

  const handleBusyGoalClear = useCallback(
    (text: string) => {
      if (!requireActiveSessionForLocalCommand()) return false;
      store.appendLocalUserMessage(text);
      sessionActions.clearGoal().catch((error: unknown) => {
        reportError(error, 'Failed to clear /goal');
      });
      return true;
    },
    [reportError, requireActiveSessionForLocalCommand, sessionActions, store],
  );

  const loadRewindSnapshots = useCallback(
    () => sessionActions.getRewindSnapshots(),
    [sessionActions],
  );

  const rewindConversationOnly = useCallback(
    (promptId: string) =>
      sessionActions
        .rewindSession(promptId, { rewindFiles: false })
        .then(() => undefined),
    [sessionActions],
  );

  const handleRewindError = useCallback(
    (error: unknown) => {
      if (isAlreadyDispatched(error)) return;
      const reason = error instanceof Error ? error.message : String(error);
      pushToast('error', t('rewind.failed', { reason }));
    },
    [pushToast, t],
  );

  const handleGoalSlashCommand = useCallback(
    (
      text: string,
      images?: PromptImage[],
      opts?: {
        sendToDaemon?: boolean;
        commitComposerAccepted?: ComposerSubmitCommit;
      },
    ) => {
      const goalArg = goalArgOf(text);
      const sendToDaemon = opts?.sendToDaemon ?? true;
      const sendGoalPrompt = () => {
        const deferComposerCommit = Boolean(onSubmitBeforeRef.current);
        const clearComposerOnPromptStart =
          !connectionRef.current.sessionId || deferComposerCommit;
        sendPrompt(text, images, {
          clearComposerOnPromptStart,
          commitComposerAccepted: deferComposerCommit
            ? opts?.commitComposerAccepted
            : undefined,
        }).catch((error: unknown) => {
          reportError(error, 'Failed to send /goal command');
        });
        return clearComposerOnPromptStart ? false : true;
      };

      if (goalArg && isGoalClearKeyword(goalArg)) {
        if (!sendToDaemon) {
          store.appendLocalUserMessage(text);
          dispatchGoalCleared(activeGoalRef.current);
          return true;
        }
        return handleBusyGoalClear(text);
      } else if (goalArg) {
        if (!sendToDaemon) {
          store.appendLocalUserMessage(text);
          dispatchGoalSet(goalArg, Date.now());
          return true;
        }
        return sendGoalPrompt();
      }

      // Bare `/goal` opens the Goals page instead of asking the daemon to print
      // its status as text — the same move `/schedule` makes. Nothing is sent,
      // so the composer is cleared by returning true.
      openGoals();
      return true;
    },
    [
      dispatchGoalCleared,
      dispatchGoalSet,
      handleBusyGoalClear,
      openGoals,
      reportError,
      sendPrompt,
      store,
      connectionRef,
    ],
  );

  const hiddenCommands = useMemo(
    () =>
      new Set(
        (hiddenSlashCommands ?? []).map(normalizeHiddenCommand).filter(Boolean),
      ),
    [hiddenSlashCommands],
  );
  const hideSettings = hiddenCommands.has('settings');

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      commitComposerAccepted?: ComposerSubmitCommit,
      metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
    ) => {
      if (
        invokeSlashCommandHandler(text, onSlashCommandRef.current, reportError)
      ) {
        return true;
      }
      if (connectionRef.current.loadingTranscript) {
        pushToast('warning', t('editor.sessionLoading'));
        return false;
      }
      if (
        shouldBlockComposerSubmit({
          connectionStatus: connectionRef.current.status,
          hasSession: Boolean(connectionRef.current.sessionId),
          restartSseOnPrompt: Boolean(restartSseOnPrompt),
        })
      ) {
        pushToast('warning', t('editor.connectionDisconnected'));
        return false;
      }
      const promptBlocked = streamingStateRef.current !== 'idle';
      const submitPromptFromEditor = (
        promptText: string,
        promptImages: PromptImage[] | undefined,
        errorMessage: string,
        opts?: {
          optimisticUserMessage?: boolean;
          retry?: boolean;
          inputAnnotations?: DaemonInputAnnotation[];
        },
      ) => {
        const deferComposerCommit = Boolean(onSubmitBeforeRef.current);
        const clearComposerOnPromptStart =
          !connectionRef.current.sessionId || deferComposerCommit;
        sendPrompt(promptText, promptImages, {
          ...opts,
          clearComposerOnPromptStart,
          commitComposerAccepted: deferComposerCommit
            ? commitComposerAccepted
            : undefined,
        }).catch((error: unknown) => reportError(error, errorMessage));
        return clearComposerOnPromptStart ? false : true;
      };
      if (text.startsWith('/')) {
        const match = text.match(SLASH_COMMAND_PATTERN);
        if (match) {
          const cmd = match[1];
          if (hiddenCommands.has(normalizeHiddenCommand(cmd))) {
            if (promptBlocked) {
              return enqueuePrompt(
                text,
                images,
                undefined,
                commitComposerAccepted,
                metadata?.inputAnnotations,
              );
            }
            return submitPromptFromEditor(
              text,
              images,
              'Failed to send hidden slash command',
              { inputAnnotations: metadata?.inputAnnotations },
            );
          }
          if (cmd === 'help') {
            setShowHelpDialog(true);
            return true;
          }
          if (cmd === 'diff') {
            if (!gitDiffWorkspaceCwd) {
              pushToast('info', t('localCommand.diffNoWorkspace'));
              return true;
            }
            setGitDialog({ workspaceCwd: gitDiffWorkspaceCwd, view: 'diff' });
            return true;
          }
          if (cmd === 'log') {
            if (!gitDiffWorkspaceCwd) {
              pushToast('info', t('localCommand.logNoWorkspace'));
              return true;
            }
            setGitDialog({ workspaceCwd: gitDiffWorkspaceCwd, view: 'log' });
            return true;
          }
          if (cmd === 'tasks') {
            openTasksPanel();
            return true;
          }
          if (cmd === 'goal') {
            // A bare `/goal` just opens the Goals page; it neither sends a
            // prompt nor touches the session, so it works mid-turn too.
            if (!goalArgOf(text)) {
              openGoals();
              return true;
            }
            if (promptBlocked) {
              if (isGoalClearCommand(text)) {
                return handleBusyGoalClear(text);
              }
              return blockLocalCommandDuringTurn();
            }
            return handleGoalSlashCommand(text, images, {
              commitComposerAccepted,
            });
          }
          if (cmd === 'theme') {
            const themeArg = text.slice(match[0].length).trim().toLowerCase();
            if (themeArg === 'dark' || themeArg === 'light') {
              handleThemeChange(themeArg);
            } else if (!themeArg) {
              setShowThemeDialog(true);
            } else {
              pushToast('error', t('error.unsupportedTheme'));
            }
            return true;
          }
          if (cmd === 'language') {
            const args = text.slice(match[0].length).trim();
            const [subCommand, languageArg] = args.split(/\s+/);
            if (!args) {
              store.dispatch([
                {
                  type: 'status',
                  text: [
                    t('language.current', {
                      language: languageLabel(selectedLanguage),
                    }),
                    t('language.usage'),
                    t('language.options'),
                    '  - en: English',
                    '  - zh-CN: 中文',
                  ].join('\n'),
                },
              ]);
              return true;
            }
            if (subCommand?.toLowerCase() === 'ui') {
              if (!languageArg) {
                store.dispatch([
                  {
                    type: 'status',
                    text: [
                      t('language.set'),
                      '',
                      t('language.usage'),
                      '',
                      t('language.options'),
                      '  - en: English',
                      '  - zh-CN: 中文',
                    ].join('\n'),
                  },
                ]);
                return true;
              }
              const normalizedArg = languageArg.toLowerCase();
              const valid = ['en', 'zh', 'zh-cn', 'zh_cn'].includes(
                normalizedArg,
              );
              if (!valid) {
                pushToast('error', t('language.invalid'));
                return true;
              }
              const nextLanguage = normalizeLanguage(languageArg);
              handleLanguageChange(nextLanguage);
              if (!promptBlocked) {
                const deferComposerCommit = Boolean(onSubmitBeforeRef.current);
                const clearComposerOnPromptStart =
                  !connectionRef.current.sessionId || deferComposerCommit;
                sendPrompt(`/language ui ${nextLanguage}`, undefined, {
                  clearComposerOnPromptStart,
                  commitComposerAccepted: deferComposerCommit
                    ? commitComposerAccepted
                    : undefined,
                })
                  .then(() => sessionActions.refreshCommands())
                  .catch((error: unknown) => {
                    reportError(error, 'Failed to sync /language command');
                  });
                return clearComposerOnPromptStart ? false : true;
              }
              return true;
            }
          }
          if (cmd === 'copy') {
            const copyArg = text.slice(match[0].length).trim();
            copyFromLastAssistantMessage(messagesRef.current, copyArg)
              .then((result) => {
                store.dispatch([
                  {
                    type: result.status === 'error' ? 'error' : 'status',
                    text: translateCopyMessage(result.message, t),
                  },
                ]);
              })
              .catch((error: unknown) => {
                reportError(error, t('copy.failedFallback'));
              });
            return true;
          }
          if (cmd === 'delete') {
            setShowDeleteDialog(true);
            return true;
          }
          if (cmd === 'release') {
            setShowReleaseDialog(true);
            return true;
          }
          if (cmd === 'rewind') {
            if (!requireActiveSessionForLocalCommand()) return false;
            setShowRewindDialog(true);
            return true;
          }
          if (cmd === 'branch') {
            if (promptBlocked) return blockLocalCommandDuringTurn();
            const branchName = text.slice(match[0].length).trim();
            branchCurrentSession(branchName || undefined);
            return true;
          }
          if (cmd === 'fork') {
            if (promptBlocked) return blockLocalCommandDuringTurn();
            if (!requireActiveSessionForLocalCommand()) return false;
            const directive = text.slice(match[0].length).trim();
            if (!directive) {
              pushToast('error', t('fork.empty'));
              return true;
            }
            sessionActions
              .forkSession(directive)
              .then((result) => {
                if (!result.launched) {
                  pushToast('warning', t('fork.notStarted'));
                  return;
                }
                setBackgroundTasksRefreshTrigger((value) => value + 1);
                pushToast(
                  'success',
                  t('fork.started', { name: result.description }),
                );
              })
              .catch((error: unknown) => {
                const reason =
                  error instanceof Error ? error.message : String(error);
                reportError(error, t('fork.failed', { reason }));
              });
            return true;
          }
          if (cmd === 'auth') {
            setShowAuthDialog(true);
            return true;
          }
          if (cmd === 'model') {
            const modelArg = text.slice(match[0].length).trim();
            if (modelArg === '--fast') {
              setModelDialogMode('fast');
              return true;
            }
            if (modelArg.startsWith('--fast ')) {
              if (promptBlocked) {
                return enqueuePrompt(
                  text,
                  images,
                  undefined,
                  commitComposerAccepted,
                  metadata?.inputAnnotations,
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /model --fast',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            if (modelArg === '--voice') {
              if (echoOrDeferLocalCommand(text, images)) return true;
              workspaceActions
                .loadProviders()
                .then((status) => {
                  setVoiceModels(extractVoiceModels(status));
                  setModelDialogMode('voice');
                })
                .catch((error: unknown) =>
                  reportError(error, t('model.setVoice')),
                );
              return true;
            }
            if (modelArg.startsWith('--voice ')) {
              const voiceModelId = modelArg.replace(/^--voice\s+/, '');
              setWorkspaceSetting(
                'workspace',
                'voiceModel',
                voiceModelId,
              ).catch((error: unknown) =>
                reportError(error, t('model.setVoice')),
              );
              return true;
            }
            if (modelArg === '--vision') {
              setModelDialogMode('vision');
              return true;
            }
            if (modelArg.startsWith('--vision ')) {
              const visionModelId = modelArg.replace(/^--vision\s+/, '');
              setWorkspaceSetting(
                'workspace',
                'visionModel',
                visionModelId,
              ).catch((error: unknown) =>
                reportError(error, t('model.setVision')),
              );
              return true;
            }
            if (modelArg) {
              if (!connectionRef.current.sessionId) {
                setPendingModel(modelArg);
                return true;
              }
              sessionActions
                .setModel(modelArg)
                .then(() => {
                  setPendingModel(modelArg);
                })
                .catch((error: unknown) => {
                  reportError(error, t('model.switch'));
                });
            } else {
              setModelDialogMode('main');
            }
            return true;
          }
          if (cmd === 'plan') {
            if (promptBlocked) return blockLocalCommandDuringTurn();
            const prompt = text.slice(match[0].length).trim();
            if (!connectionRef.current.sessionId) {
              setPendingMode('plan');
              if (prompt) {
                return submitPromptFromEditor(
                  prompt,
                  images,
                  'Failed to send plan prompt',
                  { inputAnnotations: metadata?.inputAnnotations },
                );
              }
              return true;
            }
            if (prompt) setIsPreparingPrompt(true);
            sessionActions
              .setApprovalMode('plan')
              .then(() => {
                setPendingMode('plan');
                if (prompt) {
                  return sendPrompt(prompt, images, {
                    clearComposerOnPromptStart: true,
                    inputAnnotations: metadata?.inputAnnotations,
                  }).catch((error: unknown) =>
                    reportError(error, 'Failed to send plan prompt'),
                  );
                }
              })
              .catch((error: unknown) => {
                reportError(error, t('mode.plan'));
              })
              .finally(() => {
                if (prompt) setIsPreparingPrompt(false);
              });
            return prompt ? false : true;
          }
          if (cmd === 'approval-mode') {
            const modeArg = text.slice(match[0].length).trim();
            if (modeArg) {
              handleSetMode(modeArg);
            } else {
              setShowApprovalModeDialog(true);
            }
            return true;
          }
          if (cmd === 'mcp') {
            const mcpArg = text.slice(match[0].length).trim().toLowerCase();
            workspaceActions
              .loadMcpStatus()
              .then((status) => {
                setMcpDialogMessage({
                  status,
                  toolsByServer: {},
                  resourcesByServer: {},
                  showDescriptions: mcpArg === 'desc',
                  showSchema: mcpArg === 'schema',
                  showTips: !mcpArg,
                });
                openPanel('mcp');
              })
              .catch((error: unknown) => {
                reportError(error, 'Failed to load MCP status');
              });
            return true;
          }
          if (cmd === 'skills') {
            const skillArg = text.slice(match[0].length).trim();
            if (!skillArg || skillArg === 'detail' || skillArg === 'details') {
              openPanel('skills');
            } else {
              if (promptBlocked) {
                return enqueuePrompt(
                  text,
                  images,
                  undefined,
                  commitComposerAccepted,
                  metadata?.inputAnnotations,
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /skills command',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            return true;
          }
          if (cmd === 'tools') {
            const toolsArg = text.slice(match[0].length).trim().toLowerCase();
            if (toolsArg === 'desc' || toolsArg === 'descriptions') {
              setShowToolsDialog(true);
            } else {
              if (echoOrDeferLocalCommand(text, images)) return true;
              workspaceActions
                .loadToolsStatus()
                .then((status) => {
                  const tools = status?.tools ?? [];
                  if (tools.length === 0) {
                    store.dispatch([{ type: 'status', text: t('tools.none') }]);
                  } else {
                    const list = tools
                      .map((tool) => `- ${tool.displayName || tool.name}`)
                      .join('\n');
                    store.dispatch([
                      {
                        type: 'status',
                        text: `${t('tools.available')}\n\n${list}`,
                      },
                    ]);
                  }
                  resumeChatBottomFollow('smooth');
                })
                .catch((error: unknown) => {
                  reportError(error, 'Failed to load tools');
                });
            }
            return true;
          }
          if (cmd === 'settings') {
            openPanel('settings');
            return true;
          }
          if (cmd === 'schedule') {
            openScheduledTasks();
            return true;
          }
          if (cmd === 'context') {
            const contextArg = text.slice(match[0].length).trim().toLowerCase();
            if (
              contextArg === '' ||
              contextArg === 'detail' ||
              contextArg === '-d'
            ) {
              showContextUsage(
                text,
                contextArg === 'detail' || contextArg === '-d',
              );
              return true;
            }
          }
          if (cmd === 'memory') {
            const memoryArg = text.slice(match[0].length).trim().toLowerCase();
            if (memoryArg === 'refresh') {
              setMemoryRefreshSignal((signal) => signal + 1);
            } else if (memoryArg === 'add' || memoryArg.startsWith('add ')) {
              const addTarget = memoryArg.slice('add'.length).trim();
              setMemoryAddScope(
                addTarget === 'user' || addTarget === 'global'
                  ? 'global'
                  : 'workspace',
              );
              setMemoryAddSignal((signal) => signal + 1);
            }
            setShowMemoryDialog(true);
            return true;
          }
          if (cmd === 'agents') {
            const subCommand = text.slice(match[0].length).trim().toLowerCase();
            let agentsMode: AgentsInitialMode = 'menu';
            if (subCommand === 'create') {
              agentsMode = 'create';
            } else if (
              subCommand === 'create user' ||
              subCommand === 'create global'
            ) {
              agentsMode = 'create-user';
            } else if (
              subCommand === 'create project' ||
              subCommand === 'create workspace'
            ) {
              agentsMode = 'create-project';
            } else if (subCommand === 'manage') {
              agentsMode = 'manage';
            }
            setAgentsDialogMode(agentsMode);
            return true;
          }
          if (cmd === 'extensions') {
            const args = text.slice(match[0].length).trim();
            const subCommand = args.split(/\s+/)[0]?.toLowerCase();
            if (!subCommand || subCommand === 'manage') {
              openPanel('extensions');
              return true;
            }
            if (subCommand === 'install') {
              // Install echoes into the transcript (and its error/usage replies
              // do too); block it mid-turn so it can't split the active turn.
              if (promptBlocked) return blockLocalCommandDuringTurn();
              const tokens = args.slice('install'.length).trim().split(/\s+/);
              let source = '';
              let ref: string | undefined;
              let registry: string | undefined;
              let autoUpdate: boolean | undefined;
              let allowPreRelease: boolean | undefined;
              let parseError: string | null = null;
              for (let index = 0; index < tokens.length; index++) {
                const token = tokens[index];
                if (!token) continue;
                if (token === '--auto-update') {
                  autoUpdate = true;
                } else if (
                  token === '--pre-release' ||
                  token === '--allow-pre-release'
                ) {
                  allowPreRelease = true;
                } else if (token === '--ref' || token === '--registry') {
                  const value = tokens[index + 1];
                  if (!value || value.startsWith('--')) {
                    parseError = t('extensions.install.missingOptionValue', {
                      option: token,
                    });
                    break;
                  }
                  if (token === '--ref') {
                    ref = value;
                  } else {
                    registry = value;
                  }
                  index += 1;
                } else if (token.startsWith('--')) {
                  parseError = t('extensions.install.unknownOption', {
                    option: token,
                  });
                  break;
                } else if (!source) {
                  source = token;
                } else {
                  parseError = t('extensions.install.usage');
                  break;
                }
              }
              if (parseError) {
                store.appendLocalUserMessage(text);
                store.dispatch([{ type: 'error', text: parseError }]);
                return true;
              }
              if (!source) {
                store.appendLocalUserMessage(text);
                store.dispatch([
                  {
                    type: 'error',
                    text: t('extensions.install.usage'),
                  },
                ]);
                return true;
              }
              const clientId = connectionRef.current.clientId;
              if (!clientId) {
                pushToast('warning', t('extensions.install.waitForSession'));
                return true;
              }
              store.appendLocalUserMessage(text);
              store.dispatch([
                {
                  type: 'status',
                  text: t('extensions.install.started', { source }),
                },
              ]);
              workspaceActions
                .installExtension(
                  {
                    source,
                    ...(ref ? { ref } : {}),
                    ...(registry ? { registry } : {}),
                    ...(autoUpdate !== undefined ? { autoUpdate } : {}),
                    ...(allowPreRelease !== undefined
                      ? { allowPreRelease }
                      : {}),
                    consent: true,
                  },
                  clientId,
                )
                .then(() => undefined)
                .catch((error: unknown) => {
                  reportError(error, t('extensions.install.requestFailed'));
                });
              return true;
            }
            if (echoOrDeferLocalCommand(text, images)) return true;
            store.dispatch([
              {
                type: 'error',
                text: t('extensions.install.usage'),
              },
            ]);
            return true;
          }
          if (cmd === 'clear') {
            createNewSession();
            return true;
          }
          if (cmd === 'new' || cmd === 'reset') {
            createNewSession();
            return true;
          }
          if (cmd === 'rename') {
            const renameArg = parseRenameArgument(text.slice(match[0].length));
            if (renameArg.type === 'auto' || renameArg.type === 'delegate') {
              if (promptBlocked) {
                return enqueuePrompt(
                  text,
                  images,
                  undefined,
                  commitComposerAccepted,
                  metadata?.inputAnnotations,
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /rename command',
                { inputAnnotations: metadata?.inputAnnotations },
              );
            }
            const displayName = renameArg.displayName;
            if (!displayName) {
              pushToast('error', t('rename.empty'));
              return true;
            }
            if (!requireActiveSessionForLocalCommand()) return false;
            sessionActions
              .renameSession(displayName)
              .then(() => {
                store.dispatch([
                  {
                    type: 'status',
                    text: t('rename.success', { name: displayName }),
                  },
                ]);
              })
              .catch((error: unknown) => {
                reportError(error, 'Failed to rename session');
              });
            return true;
          }
          if (cmd === 'resume') {
            const sessionId = text.slice(match[0].length).trim();
            if (sessionId) {
              closeMobileDrawer();
              // Resuming a session means the user wants to see that chat, so
              // close any open Settings/Status panel (no-op when already closed),
              // consistent with createNewSession / loadSidebarSession.
              closePanel();
              sessionActions.loadSession(sessionId).catch((error: unknown) => {
                reportError(error, 'Failed to load session');
              });
            } else {
              closeMobileDrawer();
              setShowResumeDialog(true);
            }
            return true;
          }
          if (cmd === 'recap') {
            runVisibleRecap();
            return true;
          }
          if (cmd === 'btw') {
            runVisibleBtw(text.slice(match[0].length));
            return true;
          }
          if (cmd === 'stats') {
            const statsArg = text.slice(match[0].length).trim().toLowerCase();
            let statsView: StatsView = 'overview';
            if (statsArg === 'model') statsView = 'model';
            else if (statsArg === 'tools') statsView = 'tools';
            if (!requireActiveSessionForLocalCommand()) return false;
            if (echoOrDeferLocalCommand(text, images)) return true;
            sessionActions
              .getStats()
              .then((result) => {
                store.dispatch([
                  {
                    type: 'status',
                    text: serializeStatsMessage(result, statsView),
                  },
                ]);
                resumeChatBottomFollow('smooth');
              })
              .catch(() => {});
            return true;
          }
          if (cmd === 'status' || cmd === 'about') {
            if (echoOrDeferLocalCommand(text, images)) return true;
            Promise.all([
              workspaceActions.loadPreflight().catch(() => null),
              workspaceActions.loadProviders().catch(() => null),
              workspaceActions.loadEnv().catch(() => null),
            ]).then(([preflight, providers, env]) => {
              const sys = collectSystemInfo(preflight, env);

              let authSource = sys.authSource;
              if (!authSource && providers?.current?.authType) {
                authSource = providers.current.authType;
              }

              const runtimeParts: string[] = [];
              if (sys.nodeVersion)
                runtimeParts.push(`Node.js v${sys.nodeVersion}`);
              if (sys.npmVersion) runtimeParts.push(`npm ${sys.npmVersion}`);

              let formattedAuth = '';
              if (authSource) {
                if (
                  authSource.startsWith('oauth') ||
                  authSource === 'qwen-oauth'
                ) {
                  formattedAuth = 'Qwen OAuth';
                } else {
                  formattedAuth = `API Key - ${authSource}`;
                }
              }

              const platformStr = `${sys.platform} ${sys.arch}`.trim();
              const curModel = currentModelRef.current;
              const conn = connectionRef.current;
              const qwenCodeVersion = conn.capabilities?.qwenCodeVersion || '';
              const info: StatusInfo = {
                cliVersion: qwenCodeVersion,
                runtime: runtimeParts.join(' / '),
                platform: platformStr,
                auth: formattedAuth,
                baseUrl: providers?.current?.baseUrl || '',
                model:
                  curModel ||
                  conn.currentModel ||
                  providers?.current?.modelId ||
                  '',
                fastModel:
                  providers?.current?.fastModelId ||
                  curModel ||
                  conn.currentModel ||
                  providers?.current?.modelId ||
                  '',
                sessionId: conn.sessionId || '',
                sandbox: sys.sandbox,
                proxy: sys.proxy,
                memoryUsage: sys.memoryUsage,
              };

              store.dispatch([
                { type: 'status', text: serializeStatusMessage(info) },
              ]);
              resumeChatBottomFollow('smooth');
            });
            return true;
          }
          if (cmd === 'bug') {
            const bugTitle = text.slice(match[0].length).trim();
            if (echoOrDeferLocalCommand(text, images)) return true;
            Promise.all([
              workspaceActions.loadPreflight().catch(() => null),
              workspaceActions.loadEnv().catch(() => null),
            ])
              .then(([preflight, env]) => {
                const sys = collectSystemInfo(preflight, env);
                const qwenCodeVersion =
                  connectionRef.current.capabilities?.qwenCodeVersion || '';
                const sysInfo: Record<string, string> = {};
                if (qwenCodeVersion) sysInfo.cliVersion = qwenCodeVersion;
                if (sys.nodeVersion) sysInfo.nodeVersion = sys.nodeVersion;
                if (sys.npmVersion) sysInfo.npmVersion = sys.npmVersion;
                if (sys.platform) sysInfo.platform = sys.platform;
                if (sys.arch) sysInfo.arch = sys.arch;
                if (sys.sandbox) sysInfo.sandbox = sys.sandbox;
                if (sys.memoryUsage) sysInfo.memoryUsage = sys.memoryUsage;
                if (onBugReportRef.current) {
                  onBugReportRef.current({
                    title: bugTitle,
                    systemInfo: sysInfo,
                  });
                  store.dispatch([
                    { type: 'status', text: t('bug.submitted') },
                  ]);
                } else {
                  const fields = Object.entries(sysInfo)
                    .filter(([, v]) => v)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n');
                  const url =
                    `https://github.com/QwenLM/qwen-code/issues/new?template=bug_report.yml` +
                    `&title=${encodeURIComponent(bugTitle)}` +
                    `&info=${encodeURIComponent('\n' + fields + '\n')}`;
                  const win = window.open(url, '_blank');
                  if (win) {
                    win.opener = null;
                    store.dispatch([
                      { type: 'status', text: t('bug.submitted') },
                    ]);
                  } else {
                    pushToast('error', t('bug.popupBlocked'));
                  }
                }
              })
              .catch((error: unknown) => {
                reportError(error, t('bug.failed'));
              });
            return true;
          }
        }
        // Forward slash commands as prompts
        if (promptBlocked) {
          return enqueuePrompt(
            text,
            images,
            undefined,
            commitComposerAccepted,
            metadata?.inputAnnotations,
          );
        }
        return submitPromptFromEditor(text, images, 'Failed to send command', {
          inputAnnotations: metadata?.inputAnnotations,
        });
      } else if (text.startsWith('!')) {
        if (promptBlocked) {
          pushToast('error', t('queue.shellBlocked'));
          return false;
        }
        const cmd = text.slice(1).trim();
        if (!cmd) return false;
        if (!requireActiveSessionForLocalCommand()) return false;
        sessionActions.sendShellCommand(cmd).catch((error: unknown) => {
          reportError(error, 'Failed to execute shell command');
        });
        return true;
      } else {
        if (promptBlocked) {
          return enqueuePrompt(
            text,
            images,
            undefined,
            commitComposerAccepted,
            metadata?.inputAnnotations,
          );
        }
        return submitPromptFromEditor(text, images, 'Failed to send message', {
          inputAnnotations: metadata?.inputAnnotations,
        });
      }
    },
    [
      sendPrompt,
      sessionActions,
      store,
      enqueuePrompt,
      echoOrDeferLocalCommand,
      branchCurrentSession,
      closeMobileDrawer,
      closePanel,
      openPanel,
      openScheduledTasks,
      openGoals,
      createNewSession,
      gitDiffWorkspaceCwd,
      handleBusyGoalClear,
      handleGoalSlashCommand,
      handleThemeChange,
      handleSetMode,
      handleLanguageChange,
      blockLocalCommandDuringTurn,
      openTasksPanel,
      hiddenCommands,
      pushToast,
      reportError,
      runVisibleRecap,
      runVisibleBtw,
      requireActiveSessionForLocalCommand,
      restartSseOnPrompt,
      resumeChatBottomFollow,
      selectedLanguage,
      setPendingModel,
      setPendingMode,
      setWorkspaceSetting,
      showContextUsage,
      t,
      workspaceActions,
    ],
  );

  const handleEditorSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      commitComposerAccepted?: ComposerSubmitCommit,
      metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
    ) => {
      const accepted = handleSubmit(
        text,
        images,
        commitComposerAccepted,
        metadata,
      );
      if (accepted !== false) {
        resumeChatBottomFollow('smooth');
      }
      return accepted;
    },
    [handleSubmit, resumeChatBottomFollow],
  );

  const handleConfirm = useCallback(
    (id: string, selectedOption: string, answers?: Record<string, string>) => {
      sessionActions
        .submitPermission(id, selectedOption, answers)
        .catch((error: unknown) => {
          reportError(error, 'Failed to submit permission choice');
        });
    },
    [sessionActions, reportError],
  );

  const handleCancel = useCallback(() => {
    sessionActions.cancel().catch((error: unknown) => {
      reportError(error, 'Failed to cancel request');
    });
  }, [sessionActions, reportError]);

  const handleFocusTaskPill = useCallback((): boolean => {
    if (interactionBlocked) return false;
    return statusBarRef.current?.focusTaskPill() ?? false;
  }, [interactionBlocked]);

  const handleReturnToEditor = useCallback((text?: string) => {
    if (text) {
      editorRef.current?.insertText(text);
      return;
    }
    editorRef.current?.focus();
  }, []);
  const handleCanScrollToBottomChange = useCallback(
    (canScrollToBottom: boolean) => {
      setCanScrollMessageListToBottom(canScrollToBottom);
    },
    [],
  );

  const handleRetry = useCallback(() => {
    if (
      showRetryHintRef.current &&
      connected &&
      streamingStateRef.current === 'idle' &&
      retryableTurnErrorIdRef.current &&
      lastSubmittedPromptRef.current
    ) {
      retriedTurnErrorIdRef.current = retryableTurnErrorIdRef.current;
      setShowRetryHint(false);
      sendPrompt(
        lastSubmittedPromptRef.current,
        lastSubmittedImagesRef.current,
        {
          optimisticUserMessage: false,
          retry: true,
        },
      ).catch((error: unknown) => reportError(error, 'Failed to retry prompt'));
    } else {
      store.dispatch([{ type: 'status', text: t('retry.none') }]);
    }
  }, [connected, sendPrompt, reportError, store, t]);

  useEffect(() => {
    const onGlobalShortcut = (e: KeyboardEvent) => {
      if (interactionBlocked) return;
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (e.key === 'l') {
          e.preventDefault();
          handleClearScreen();
          return;
        }
        if (e.key === 'o') {
          e.preventDefault();
          handleToggleCompact();
          return;
        }
        if (e.key === 'y') {
          e.preventDefault();
          handleRetry();
          return;
        }
      }
    };
    window.addEventListener('keydown', onGlobalShortcut, true);
    return () => window.removeEventListener('keydown', onGlobalShortcut, true);
  }, [
    interactionBlocked,
    handleClearScreen,
    handleToggleCompact,
    handleRetry,
    store,
    t,
  ]);

  const resetEscapeState = useCallback(() => {
    escArmedActionRef.current = null;
    setEscapeHintVisible(false);
    setCancelArmed(false);
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = null;
    }
  }, []);

  // The Esc handler reads live state, but its global keydown listener must mount
  // ONCE: streamingState flips among 'waiting'/'responding'/'thinking' mid-turn,
  // and if it were an effect dep each flip would tear the listener down and run
  // resetEscapeState(), wiping a half-armed two-press cancel. Read live values
  // through a ref so the listener stays put across re-renders.
  const escLiveRef = useRef({
    streamingState,
    pendingApproval,
    interactionBlocked,
    activePanel,
    closePanel,
    handleCancel,
    handleCycleMode,
  });
  escLiveRef.current = {
    streamingState,
    pendingApproval,
    interactionBlocked,
    activePanel,
    closePanel,
    handleCancel,
    handleCycleMode,
  };

  // Clear a half-armed two-press whenever the streaming/idle boundary flips — the
  // relevant action (cancel vs clear) changes with it, so a leftover arm is now
  // stale. Keyed on the boolean, so intra-turn sub-state flips don't reset it.
  const escStreamingBoundary = streamingState !== 'idle';
  useEffect(() => {
    resetEscapeState();
  }, [escStreamingBoundary, resetEscapeState]);

  useEffect(() => {
    // Arm a two-press action: the first Esc shows the affordance and starts a
    // confirm window; a second Esc within it confirms, any other key resets it.
    const ESC_CANCEL_CONFIRM_WINDOW_MS = 2000;
    const ESC_CLEAR_CONFIRM_WINDOW_MS = 500;
    const armEscape = (action: 'cancel' | 'clear', windowMs: number) => {
      escArmedActionRef.current = action;
      if (action === 'cancel') setCancelArmed(true);
      else setEscapeHintVisible(true);
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = setTimeout(resetEscapeState, windowMs);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const live = escLiveRef.current;

      // A full-view panel (Settings / Daemon Status) replaces the chat rather
      // than overlaying it; Escape returns to the chat. Any modal opened on top
      // of the panel is a DialogShell, whose own handler stops Escape from
      // reaching this window listener, so this only fires when the panel itself
      // is the topmost surface.
      if (e.key === 'Escape' && live.activePanel) {
        // The sidebar stays usable beside the panel and its search input clears
        // on Escape without stopping the event; don't also close the panel when
        // Escape is being handled inside the sidebar. Scope the panel close to
        // Escape originating outside the sidebar drawer.
        const target = e.target as HTMLElement | null;
        if (!target?.closest('[data-sidebar-shell]')) {
          e.preventDefault();
          live.closePanel();
        }
        return;
      }

      if (e.key !== 'Escape') {
        if (escArmedActionRef.current !== null) {
          resetEscapeState();
        }
        if (e.key === 'Tab' && e.shiftKey && !live.interactionBlocked) {
          e.preventDefault();
          live.handleCycleMode();
        }
        return;
      }

      // Streaming takes priority over clearing text (queued prompts stay intact
      // and drain after the turn settles); see decideEscapeIntent for the rules.
      const intent = decideEscapeIntent({
        blocked: !!live.pendingApproval || live.interactionBlocked,
        streaming: live.streamingState !== 'idle',
        hasInput: !!editorRef.current?.hasInput(),
        armed: escArmedActionRef.current,
      });
      if (intent.kind === 'ignore') return;
      e.preventDefault();
      switch (intent.kind) {
        case 'cancel':
          live.handleCancel();
          resetEscapeState();
          break;
        case 'clear':
          editorRef.current?.clear();
          resetEscapeState();
          break;
        case 'arm':
          armEscape(
            intent.action,
            intent.action === 'cancel'
              ? ESC_CANCEL_CONFIRM_WINDOW_MS
              : ESC_CLEAR_CONFIRM_WINDOW_MS,
          );
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      resetEscapeState();
    };
  }, [resetEscapeState]);

  const isDisabled = shouldDisableComposerInput({
    catchingUp: Boolean(connection.catchingUp),
    pendingApproval: pendingApproval !== null,
    isPreparingPrompt,
  });
  const composerPlaceholderInputState = {
    catchingUp: Boolean(connection.catchingUp),
    isPreparingPrompt,
    isStreaming: streamingState !== 'idle',
  };
  const composerPlaceholderState = getComposerPlaceholderState(
    composerPlaceholderInputState,
  );
  const customComposerPlaceholder =
    composerPlaceholders?.[composerPlaceholderState];
  const composerPlaceholderText = customComposerPlaceholder?.trim()
    ? customComposerPlaceholder
    : t(getComposerPlaceholderKey(composerPlaceholderInputState));

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (!connectionRef.current.sessionId) {
        setPendingModel(modelId);
        return;
      }
      // Drive the shared busy flag so the model-management rows disable while a
      // selection is in flight — rapid Set current clicks would otherwise launch
      // concurrent setModel calls that can resolve out of order and leave a
      // model other than the user's last click active.
      setModelActionBusy(true);
      sessionActions
        .setModel(modelId)
        .then((result) => {
          const summary = getModelSwitchSummary(result);
          setPendingModel(summary?.modelId ?? modelId);
          if (summary) {
            store.dispatch({
              type: 'debug',
              text: serializeModelSwitchSummary(summary, t),
              source: 'model_switch_summary',
              data: summary,
            });
          }
        })
        .catch((error: unknown) => {
          reportError(error, t('model.switch'));
        })
        .finally(() => setModelActionBusy(false));
    },
    [sessionActions, store, reportError, t, setPendingModel],
  );

  const handleDeleteModel = useCallback(
    (target: { authType: string; modelId: string; baseUrl?: string }) => {
      setModelActionBusy(true);
      workspaceActions
        .deleteModel(target)
        .then((result) => {
          // A scrubbed fallback requires a restart — surface it like the
          // settings panel does.
          if (result?.requiresRestart) {
            store.dispatch([
              { type: 'status', text: t('settings.requiresRestart') },
            ]);
          }
          // A transient reload failure shouldn't surface as "delete failed" —
          // the model was already removed. Just log it. Reload settings too so a
          // cleared active model / scrubbed fallback isn't shown stale.
          reloadProviders().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload providers after delete',
              err,
            );
          });
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload settings after delete',
              err,
            );
          });
        })
        .catch((error: unknown) => {
          reportError(error, t('settings.models.deleteFailed'));
        })
        .finally(() => setModelActionBusy(false));
    },
    // Depend on the stable `reload` fn, not the whole providersState object,
    // which useProviders returns fresh each render (would defeat the memo).
    [
      workspaceActions,
      reloadProviders,
      reloadWorkspaceSettings,
      reportError,
      store,
      t,
    ],
  );

  const handleCloseAuthDialog = useCallback(() => {
    setShowAuthDialog(false);
    // The provider install flow doesn't broadcast a settings change, so refresh
    // the model list on close to surface any newly added models. Log a failed
    // reload (leaves stale model data) rather than swallowing it.
    reloadProviders().catch((err: unknown) => {
      console.warn(
        '[web-shell] failed to reload providers after auth dialog close',
        err,
      );
    });
  }, [reloadProviders]);

  const handleFallbacksConfirm = useCallback(
    (baseIds: string[]) => {
      setShowFallbacksDialog(false);
      setWorkspaceSetting(
        modelSettingScope,
        'modelFallbacks',
        baseIds.join(','),
      )
        .then((result) => {
          // modelFallbacks requiresRestart — tell the user, like the settings
          // panel does for restart-required edits.
          if (result?.requiresRestart) {
            store.dispatch([
              { type: 'status', text: t('settings.requiresRestart') },
            ]);
          }
          // A reload failure shouldn't surface as "save failed" — the value
          // was already persisted. Just log it.
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload settings after fallbacks save',
              err,
            );
          });
        })
        .catch((error: unknown) =>
          reportError(error, t('settings.models.fallbacks.saveFailed')),
        );
    },
    [
      modelSettingScope,
      setWorkspaceSetting,
      reloadWorkspaceSettings,
      reportError,
      store,
      t,
    ],
  );

  const handleFastModelSelect = useCallback(
    (modelId: string) => {
      if (streamingState !== 'idle') {
        blockLocalCommandDuringTurn();
        return;
      }
      // Model IDs from the picker arrive as bare model IDs (baseModelId), not
      // ACP format. The model picker strips the (authType) suffix before
      // calling this handler.
      //
      // Close the panel before sending: unlike the vision/voice pickers (silent
      // setWorkspaceSetting), `/model --fast` runs a real turn whose response
      // lands in the message list. With the panel open the chat is hidden, so
      // that response would pile up behind it and surprise the user on close.
      // Closing first returns them to the chat to see it in context (matching
      // the pre-panel modal behavior).
      closePanel();
      // Persist to the scope the picker was opened for (matching the silent
      // vision/voice pickers). `/model` parses --global/--project as the persist
      // scope; without a flag the command would default to its own scope logic
      // and ignore the user's User-vs-Workspace choice.
      const scopeFlag =
        modelSettingScope === 'user' ? ' --global' : ' --project';
      sendPrompt(`/model --fast ${modelId}${scopeFlag}`)
        .then(() => {
          // sendPrompt resolves only after the `/model --fast` turn *completes*
          // (actions.ts → waitForAcceptedPromptCompletion), so the change is
          // already applied here — this reload reads the new value, not a stale
          // one. It keeps the workspace-settings state fresh for the next time
          // Settings is opened (the command path, unlike setWorkspaceSetting,
          // doesn't bump the settingsVersion signal). Guard its own rejection —
          // the .catch below only covers sendPrompt — and log it so a failed
          // reload (leaving stale settings on next open) leaves a trace.
          reloadWorkspaceSettings().catch((err: unknown) => {
            console.warn(
              '[web-shell] failed to reload workspace settings after fast-model switch',
              err,
            );
          });
        })
        .catch((error: unknown) => {
          reportError(error, 'Failed to switch fast model');
        });
    },
    [
      blockLocalCommandDuringTurn,
      closePanel,
      sendPrompt,
      streamingState,
      reportError,
      reloadWorkspaceSettings,
      modelSettingScope,
    ],
  );

  const handleVoiceModelSelect = useCallback(
    (modelId: string) => {
      // Model IDs from the voice picker arrive as bare model IDs (baseModelId),
      // not ACP format. extractVoiceModels() sets id to the baseModelId.
      const bareModelId = extractBareModelId(modelId);
      setWorkspaceSetting(modelSettingScope, 'voiceModel', bareModelId).catch(
        (error: unknown) => reportError(error, t('model.setVoice')),
      );
    },
    [modelSettingScope, reportError, setWorkspaceSetting, t],
  );

  const handleVisionModelSelect = useCallback(
    (modelId: string) => {
      // Model IDs from the picker arrive in ACP format: `modelId(authType)`.
      // Core's resolveVisionModelSelection() expects `authType:modelId`.
      const encoded = encodeVisionModelForSetting(modelId);
      setWorkspaceSetting(modelSettingScope, 'visionModel', encoded).catch(
        (error: unknown) => reportError(error, t('model.setVision')),
      );
    },
    [modelSettingScope, reportError, setWorkspaceSetting, t],
  );

  const modelHandlers: Record<ModelDialogMode, (id: string) => void> = {
    main: handleModelSelect,
    fast: handleFastModelSelect,
    voice: handleVoiceModelSelect,
    vision: handleVisionModelSelect,
  };

  // Once every settings-launched model surface is closed (the model picker via
  // modelDialogMode, the fallbacks dialog, or the Add Model / auth dialog),
  // reset the persist scope so a later command-launched picker defaults back
  // to workspace.
  useEffect(() => {
    if (!modelDialogMode && !showFallbacksDialog && !showAuthDialog) {
      setModelSettingScope('workspace');
    }
  }, [modelDialogMode, showFallbacksDialog, showAuthDialog]);

  const commands = useMemo(() => {
    const previousSkillNames = new Set(
      (connection.skills ?? []).map((skill) => skill.toLowerCase()),
    );
    const retainedCommands = loadedSkillsReady
      ? (connection.commands ?? []).filter(
          (command) =>
            command.source !== 'skill' &&
            !previousSkillNames.has(command.name.toLowerCase()),
        )
      : (connection.commands ?? []);
    const refreshedSkillCommands = loadedSkillsReady
      ? loadedSkills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
          source: 'skill',
          displayCategory: 'skill' as const,
        }))
      : [];
    return localizeBuiltinDescriptions(
      mergeCommands(
        retainedCommands,
        refreshedSkillCommands,
        getLocalCommands(t),
      ),
      t,
    )
      .filter(
        (command) => !hiddenCommands.has(normalizeHiddenCommand(command.name)),
      )
      .map((command) => {
        const skillKey = skillDescriptionKey(command.name);
        if (!skillKey) return command;
        return {
          ...command,
          displayCategory: 'skill' as const,
          description: t(skillKey),
        };
      });
  }, [
    connection.commands,
    connection.skills,
    hiddenCommands,
    loadedSkills,
    loadedSkillsReady,
    t,
  ]);

  const welcomeHeaderProps = useMemo(
    () => ({
      version: connection.capabilities?.qwenCodeVersion || '',
      cwd: connection.workspaceCwd || '',
      currentModel,
      currentMode,
      hideTips: hideTipsSetting?.values.effective === true,
    }),
    [
      connection.capabilities?.qwenCodeVersion,
      connection.workspaceCwd,
      currentModel,
      currentMode,
      hideTipsSetting?.values.effective,
    ],
  );

  // The empty-state toggle is offered only when the workspace the next
  // session would land in is trusted and is a git repository — the daemon
  // rejects worktree creation otherwise. Mirrors the sidebar entry's gating.
  const worktreeToggleEligible = Boolean(
    workspaces.find((entry) => entry.cwd === activeWorkspaceCwd)?.trusted &&
      selectedWorkspaceGitStatus?.branch,
  );
  const worktreeToggleRef = useRef<HTMLButtonElement>(null);
  const worktreeCancelRef = useRef<HTMLButtonElement>(null);
  const worktreeFocusTarget = useRef<'cancel' | 'toggle' | null>(null);
  const handleEnableWorktree = useCallback(() => {
    pendingWorktreeRef.current = {};
    setWorktreePending(true);
    worktreeFocusTarget.current = 'cancel';
  }, []);
  const handleCancelWorktree = useCallback(() => {
    pendingWorktreeRef.current = undefined;
    setWorktreePending(false);
    worktreeFocusTarget.current = 'toggle';
  }, []);
  useEffect(() => {
    if (!worktreeFocusTarget.current) return;
    const target = worktreeFocusTarget.current;
    worktreeFocusTarget.current = null;
    if (target === 'cancel') {
      worktreeCancelRef.current?.focus();
    } else {
      worktreeToggleRef.current?.focus();
    }
  }, [worktreePending]);
  const welcomeHeader = useMemo(
    () => (
      <>
        {renderWelcomeHeader ? (
          renderWelcomeHeader(welcomeHeaderProps)
        ) : (
          <WelcomeHeader {...welcomeHeaderProps} />
        )}
        {worktreePending ? (
          <div className={styles.worktreeWelcomeBadge}>
            <span className={styles.worktreeBadgeIcon}>
              <GitForkIcon size={18} strokeWidth={1.8} />
            </span>
            <span className={styles.worktreeBadgeText}>
              <span className={styles.worktreeWelcomeTitle}>
                {t('worktree.welcomeTitle')}
              </span>
              <span className={styles.worktreeWelcomeDesc}>
                {t('worktree.welcomeDesc')}
              </span>
            </span>
            <button
              ref={worktreeCancelRef}
              type="button"
              className={styles.worktreeWelcomeCancel}
              aria-label={t('worktree.cancel')}
              data-testid="worktree-welcome-cancel"
              onClick={handleCancelWorktree}
            >
              <XIcon size={14} strokeWidth={2} />
            </button>
          </div>
        ) : (
          worktreeToggleEligible && (
            <button
              ref={worktreeToggleRef}
              type="button"
              className={styles.worktreeWelcomeToggle}
              data-testid="worktree-welcome-toggle"
              onClick={handleEnableWorktree}
            >
              <span className={styles.worktreeToggleIcon}>
                <GitForkIcon size={16} strokeWidth={1.8} />
              </span>
              <span className={styles.worktreeToggleText}>
                <span className={styles.worktreeToggleLabel}>
                  {t('worktree.welcomeTitle')}
                </span>
                <span className={styles.worktreeToggleHint}>
                  {t('worktree.toggleHint')}
                </span>
              </span>
            </button>
          )
        )}
      </>
    ),
    [
      renderWelcomeHeader,
      welcomeHeaderProps,
      worktreePending,
      worktreeToggleEligible,
      handleEnableWorktree,
      handleCancelWorktree,
      t,
    ],
  );
  const welcomeFooter = useMemo(
    () => renderWelcomeFooter?.(welcomeHeaderProps),
    [renderWelcomeFooter, welcomeHeaderProps],
  );
  const isChatEmptyState =
    !connection.sessionId &&
    displayMessages.length === 0 &&
    !showFloatingTodos &&
    !pendingApproval &&
    !btwMessage;
  const useMobileWelcomeMiddleLayout =
    isChatEmptyState && mobileWelcomeFooterMiddle;
  const showMobileWelcomeFooterMiddle =
    useMobileWelcomeMiddleLayout && Boolean(welcomeFooter);
  const hasWelcomeMiddle = isChatEmptyState && showMobileWelcomeFooterMiddle;
  const hasMobileComposerBottom =
    isChatEmptyState && useMobileWelcomeMiddleLayout;
  const missingSession =
    connection.status !== 'connecting' &&
    !connection.sessionId &&
    connection.missingSession === true;
  const showMissingSessionState =
    missingSession && !activePanel && mainView === 'chat';
  const effectiveChatWidthMode: ChatWidthMode = isChatEmptyState
    ? getDefaultChatWidthMode()
    : chatWidthMode;
  const chatWidthToggleMin = getChatMaxWidth(chatMaxWidth);

  const appClassName = [
    styles.app,
    styles.appChat,
    isChatEmptyState ? styles.appChatEmpty : undefined,
    sidebarOptions.enabled ? styles.appWithSidebar : undefined,
    selectedTheme === WebShellThemeId.Light
      ? styles.themeLight
      : styles.themeDark,
    selectedTheme === WebShellThemeId.Dark ? 'dark' : undefined,
    externalClassName,
  ]
    .filter(Boolean)
    .join(' ');
  const appStyle = useMemo(
    () => ({
      ...externalStyle,
      ...getChatWidthStyle(effectiveChatWidthMode, chatMaxWidth),
    }),
    [chatMaxWidth, effectiveChatWidthMode, externalStyle],
  );
  const handleChatWidthModeChange = useCallback((mode: ChatWidthMode) => {
    setChatWidthMode(mode);
    writeChatWidthMode(mode);
  }, []);

  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;

    const previousRect = previousFooterRectRef.current;
    const wasEmpty = previousEmptyStateRef.current;
    const nextRect = footer.getBoundingClientRect();

    if (wasEmpty && !isChatEmptyState && previousRect) {
      const offsetY = previousRect.top - nextRect.top;
      if (Math.abs(offsetY) > 1) {
        footer.style.transition = 'width 320ms ease';
        footer.style.transform = `translateY(${offsetY}px)`;
        requestAnimationFrame(() => {
          footer.style.transition = 'width 320ms ease, transform 280ms ease';
          footer.style.transform = '';
        });
        window.setTimeout(() => {
          footer.style.transition = '';
        }, 320);
      }
    }

    previousFooterRectRef.current = nextRect;
    previousEmptyStateRef.current = isChatEmptyState;
  }, [isChatEmptyState]);

  useLayoutEffect(() => {
    const root = document.createElement('div');
    root.dataset.webShellPortalRoot = '';
    root.dataset.webShellShadcn = '';
    document.body.appendChild(root);
    setPortalRoot(root);
    return () => {
      root.remove();
      setPortalRoot(null);
    };
  }, []);

  useLayoutEffect(() => {
    const root = appRootRef.current;
    if (!root || !portalRoot) return;
    let frameId: number | null = null;
    const syncVariables = () => {
      frameId = null;
      const computedStyle = getComputedStyle(root);
      const nextNames = new Set<string>();
      portalRoot.dataset.webShellShadcn = '';
      portalRoot.classList.toggle(
        'dark',
        selectedTheme === WebShellThemeId.Dark,
      );
      portalRoot.lang = selectedLanguage;
      for (let index = 0; index < computedStyle.length; index += 1) {
        const name = computedStyle[index];
        if (!name.startsWith('--')) continue;
        nextNames.add(name);
        portalRoot.style.setProperty(
          name,
          computedStyle.getPropertyValue(name),
        );
      }
      for (const name of portalRootVariableNamesRef.current) {
        if (!nextNames.has(name)) portalRoot.style.removeProperty(name);
      }
      portalRootVariableNamesRef.current = nextNames;
    };
    const scheduleSync = () => {
      if (frameId === null) frameId = requestAnimationFrame(syncVariables);
    };
    syncVariables();
    const observer = new MutationObserver(scheduleSync);
    let element: HTMLElement | null = root;
    while (element) {
      observer.observe(element, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme', 'lang'],
      });
      element = element.parentElement;
    }
    window.addEventListener('resize', scheduleSync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleSync);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [appClassName, appStyle, portalRoot, selectedLanguage, selectedTheme]);

  return (
    <ThemeProvider value={selectedTheme}>
      <I18nProvider language={selectedLanguage}>
        {/* prettier-ignore */}
        <WebShellPortalRootContext.Provider value={portalRoot}>
        <div
          ref={appRootRef}
          className={appClassName}
          style={appStyle}
          data-web-shell-root
          data-web-shell-shadcn
          lang={selectedLanguage}
        >
          {!onToast && <ToastHost toasts={toasts} onDismiss={dismissToast} />}
          {showResumeDialog && (
            <DialogShell
              title={t('resume.title')}
              size="lg"
              onClose={() => setShowResumeDialog(false)}
            >
              <ResumeDialog
                workspaceCwd={lockedWorkspaceCwd}
                onSelect={(sessionId) => {
                  closeMobileDrawer();
                  closePanel();
                  sessionActions
                    .loadSession(sessionId)
                    .catch((error: unknown) => {
                      reportError(error, 'Failed to load session');
                    });
                }}
                onClose={() => setShowResumeDialog(false)}
              />
            </DialogShell>
          )}
          {modelDialogMode && (
            <DialogShell
              title={t(MODE_TITLE_KEY[modelDialogMode])}
              size="lg"
              onClose={() => setModelDialogMode(null)}
            >
              <ModelDialog
                mode={modelDialogMode}
                models={modelDialogMode === 'voice' ? voiceModels : undefined}
                currentModelId={
                  modelDialogMode === 'voice'
                    ? currentVoiceModel
                    : modelDialogMode === 'vision'
                      ? currentVisionModel
                      : modelDialogMode === 'fast'
                        ? currentFastModel
                        : undefined
                }
                onSelect={(modelId) => {
                  if (modelDialogMode) {
                    modelHandlers[modelDialogMode](modelId);
                  }
                  setModelDialogMode(null);
                }}
              />
            </DialogShell>
          )}
          {showApprovalModeDialog && (
            <DialogShell
              title={t('mode.select')}
              size="sm"
              onClose={() => setShowApprovalModeDialog(false)}
            >
              <ApprovalModeDialog
                currentMode={currentMode}
                onSelect={(modeId) => {
                  handleSetMode(modeId);
                  setShowApprovalModeDialog(false);
                }}
              />
            </DialogShell>
          )}
          {showToolsDialog && (
            <DialogShell
              title={t('tools.title')}
              size="lg"
              onClose={() => setShowToolsDialog(false)}
            >
              <ToolsDialog />
            </DialogShell>
          )}
          {gitDialog && (
            <GitDialog
              key={`${gitDialog.workspaceCwd}:${gitDialog.view}`}
              workspaceCwd={gitDialog.workspaceCwd}
              initialView={gitDialog.view}
              onClose={() => setGitDialog(undefined)}
            />
          )}
          {tasksDialogMessage && (
            <DialogShell
              title={t('tasks.title')}
              size="lg"
              onClose={() => setTasksDialogMessage(null)}
            >
              <TasksStatusMessage
                message={tasksDialogMessage}
                embedded
                manageActiveEvent={false}
                onClose={() => setTasksDialogMessage(null)}
              />
            </DialogShell>
          )}
          {agentsDialogMode && (
            <DialogShell
              title={
                agentsDialogMode === 'manage'
                  ? t('agent.manage')
                  : agentsDialogMode === 'menu'
                    ? t('agents.title')
                    : t('agent.create')
              }
              size="lg"
              onClose={() => setAgentsDialogMode(null)}
            >
              <AgentsMessage
                mode={agentsDialogMode}
                embedded
                onMessage={(text) => store.dispatch([{ type: 'status', text }])}
                onClose={() => setAgentsDialogMode(null)}
              />
            </DialogShell>
          )}
          {showMemoryDialog && (
            <DialogShell
              title={t('memory.menu')}
              size="lg"
              onClose={() => setShowMemoryDialog(false)}
            >
              <MemoryMessage
                refreshSignal={memoryRefreshSignal}
                addSignal={memoryAddSignal}
                addScope={memoryAddScope}
                onMessage={(text, type = 'status') => {
                  store.dispatch([{ type, text }]);
                }}
              />
            </DialogShell>
          )}
          {showHelpDialog && (
            <DialogShell
              title={t('help.title')}
              size="md"
              onClose={() => setShowHelpDialog(false)}
            >
              <HelpDialog commands={commands} />
            </DialogShell>
          )}
          {showThemeDialog && (
            <DialogShell
              title={t('theme.title')}
              size="sm"
              onClose={() => setShowThemeDialog(false)}
            >
              <ThemeDialog
                currentTheme={selectedTheme}
                onSelect={handleThemeChange}
                onClose={() => setShowThemeDialog(false)}
              />
            </DialogShell>
          )}
          {showAuthDialog && (
            <DialogShell
              title={t('auth.title')}
              size="lg"
              onClose={handleCloseAuthDialog}
            >
              <AuthMessage
                onMessage={(text, type = 'status') => {
                  store.dispatch([
                    type === 'error'
                      ? { type: 'error', text }
                      : { type: 'status', text },
                  ]);
                }}
                onClose={handleCloseAuthDialog}
              />
            </DialogShell>
          )}
          {showFallbacksDialog && (
            <DialogShell
              title={t('settings.models.fallbacks.title')}
              size="md"
              onClose={() => setShowFallbacksDialog(false)}
            >
              <ModelFallbacksDialog
                models={fallbackModelOptions}
                current={currentModelFallbacks}
                max={3}
                onConfirm={handleFallbacksConfirm}
                onClose={() => setShowFallbacksDialog(false)}
              />
            </DialogShell>
          )}
          {showDeleteDialog && (
            <DialogShell
              title={t('delete.title')}
              size="lg"
              onClose={() => setShowDeleteDialog(false)}
            >
              <DeleteSessionDialog
                workspaceCwd={lockedWorkspaceCwd}
                onDeleted={(sessionIds) => {
                  store.dispatch([
                    {
                      type: 'status',
                      text:
                        sessionIds.length === 1
                          ? `${t('delete.deleted')} (${sessionIds[0]!.slice(0, 8)})`
                          : t('delete.deletedCount', {
                              count: sessionIds.length,
                            }),
                    },
                  ]);
                }}
                onError={(error) => {
                  if (isAlreadyDispatched(error)) return;
                  const reason =
                    error instanceof Error ? error.message : String(error);
                  pushToast('error', t('delete.failed', { reason }));
                }}
                onClose={() => setShowDeleteDialog(false)}
              />
            </DialogShell>
          )}
          {showReleaseDialog && (
            <DialogShell
              title={t('release.title')}
              size="lg"
              onClose={() => setShowReleaseDialog(false)}
            >
              <ReleaseSessionDialog
                workspaceCwd={lockedWorkspaceCwd}
                onReleased={(sessionId) => {
                  store.dispatch([
                    {
                      type: 'status',
                      text: `${t('release.released')} (${sessionId.slice(0, 8)})`,
                    },
                  ]);
                }}
                onError={(error) => {
                  if (isAlreadyDispatched(error)) return;
                  const reason =
                    error instanceof Error ? error.message : String(error);
                  pushToast('error', t('release.failed', { reason }));
                }}
                onClose={() => setShowReleaseDialog(false)}
              />
            </DialogShell>
          )}
          {showRewindDialog && (
            <DialogShell
              title={t('rewind.title')}
              subtitle={t('rewind.subtitle')}
              size="lg"
              onClose={() => setShowRewindDialog(false)}
            >
              <RewindDialog
                blocks={blocks}
                loadSnapshots={loadRewindSnapshots}
                rewind={rewindConversationOnly}
                onError={handleRewindError}
                onClose={() => setShowRewindDialog(false)}
              />
            </DialogShell>
          )}

          <div className={styles.appShell}>
            {sidebarOptions.enabled && (
              <div
                data-sidebar-shell=""
                {...(mobileDrawerOpen
                  ? { role: 'dialog', 'aria-modal': 'true' as const }
                  : {})}
                aria-label={t('sidebar.label')}
                className={[
                  styles.mobileDrawer,
                  mobileDrawerOpen ? styles.mobileDrawerOpen : undefined,
                  forceMobileDrawer ? styles.mobileDrawerForced : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div
                  className={styles.mobileBackdrop}
                  onClick={closeMobileDrawer}
                  aria-hidden="true"
                />
                <WebShellSidebar
                  collapsed={
                    (sidebarCollapsed ||
                      (mainView === 'split' && !splitSidebarHasRoom)) &&
                    !mobileDrawerOpen
                  }
                  onCollapsedChange={handleSidebarCollapsedChange}
                  onOpenSettings={() => {
                    closeMobileDrawer();
                    openPanel('settings');
                  }}
                  onOpenPlugins={() => {
                    closeMobileDrawer();
                    openPanel('plugins');
                  }}
                  onOpenDaemonStatus={() => {
                    closeMobileDrawer();
                    openPanel('status');
                  }}
                  onOpenScheduledTasks={() => {
                    closeMobileDrawer();
                    openScheduledTasks();
                  }}
                  onOpenGoals={() => {
                    closeMobileDrawer();
                    openGoals();
                  }}
                  onOpenSessions={() => {
                    closeMobileDrawer();
                    openPanel('sessions');
                  }}
                  canOpenSessionsOverview={isLargeScreen}
                  onOpenSplitView={() => {
                    closeMobileDrawer();
                    openSplitView();
                  }}
                  canOpenSplitView={isLargeScreen}
                  theme={selectedTheme}
                  onThemeChange={(theme) => {
                    handleThemeChange(theme);
                    void setWorkspaceSetting(
                      'workspace',
                      THEME_SETTING_KEY,
                      webShellThemeToSettingValue(theme),
                    );
                  }}
                  onNewSession={(workspaceCwd) => createNewSession(workspaceCwd)}
                  onLoadSession={(sessionId, workspaceCwd) => {
                    setMainView('chat');
                    return loadSidebarSession(sessionId, workspaceCwd);
                  }}
                  onSelectCurrentSession={() => {
                    closeMobileDrawer();
                    setMainView('chat');
                    closePanel();
                  }}
                  onError={reportError}
                  mobileOpen={mobileDrawerOpen}
                  sessionListReloadToken={sessionListReloadToken}
                  selectedWorkspaceCwd={selectedWorkspaceCwd}
                  onSelectWorkspace={setSelectedWorkspaceCwd}
                  onOpenGitDiff={(workspaceCwd) =>
                    setGitDialog({ workspaceCwd, view: 'diff' })
                  }
                  workspaces={workspaces}
                  lockedWorkspaceCwd={lockedWorkspaceCwd}
                  lockedWorkspace={sidebarOptions.lockedWorkspace}
                  branding={sidebarOptions.branding}
                  footer={sidebarOptions.footer}
                />
              </div>
            )}
            <div
              ref={chatPaneRef}
              className={[
                styles.chatPane,
                mainView !== 'chat' ? styles.chatPaneShowingPage : undefined,
                hasMobileComposerBottom
                  ? styles.chatPaneWithMobileComposerBottom
                  : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {sidebarOptions.enabled &&
                sidebarOptions.showCompactToggle &&
                !activePanel &&
                mainView === 'chat' && (
                  <button
                    type="button"
                    className={[
                      styles.hamburgerButton,
                      isChatEmptyState
                        ? styles.hamburgerButtonFloating
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      setForceMobileDrawer(false);
                      setMobileDrawerOpen((open) => !open);
                    }}
                    aria-label={t('sidebar.toggleMenu')}
                    aria-expanded={mobileDrawerOpen}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <line x1="3" y1="6" x2="21" y2="6" />
                      <line x1="3" y1="12" x2="21" y2="12" />
                      <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  </button>
                )}
              {activePanel && (
                <section
                  className={styles.panelHost}
                  role="region"
                  data-testid="inline-panel"
                  aria-label={
                    activePanel === 'settings'
                      ? t('settings.title')
                      : activePanel === 'status'
                        ? t('daemon.title')
                        : activePanel === 'extensions'
                          ? t('extensions.manage.title')
                        : activePanel === 'mcp'
                          ? t('mcp.title')
                          : activePanel === 'skills'
                            ? t('skills.title')
                          : activePanel === 'plugins'
                              ? t('plugins.title')
                              : t('sessionsOverview.title')
                  }
                >
                  {activePanel !== 'extensions' &&
                    activePanel !== 'mcp' &&
                    activePanel !== 'skills' &&
                    activePanel !== 'plugins' && (
                    <div className={styles.panelHeader}>
                    <button
                      ref={panelBackRef}
                      type="button"
                      className={styles.panelBack}
                      data-testid="panel-back"
                      onClick={closePanel}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M15 5l-7 7 7 7"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                    <div className={styles.panelTitle}>
                      {activePanel === 'settings'
                        ? t('settings.title')
                        : activePanel === 'status'
                          ? t('daemon.title')
                          : t('sessionsOverview.title')}
                    </div>
                    </div>
                  )}
                  <div className={styles.panelBody} key={activePanel}>
                    {activePanel === 'settings' ? (
                      <SettingsMessage
                        settingsState={workspaceSettingsState}
                        embedded
                        onLanguageChange={handleSettingsLanguageChange}
                        onThemeChange={handleThemeChange}
                        chatWidthMode={chatWidthMode}
                        onChatWidthModeChange={handleChatWidthModeChange}
                        modelManagement={{
                          providers: providersState.providers,
                          currentModelId:
                            connection.currentModel ?? undefined,
                          loading: providersState.loading,
                          error: providersState.error,
                          busy: modelActionBusy,
                          onSelectModel: handleModelSelect,
                          onDeleteModel: handleDeleteModel,
                          onAddModel: () => setShowAuthDialog(true),
                        }}
                        onSubDialog={(key, scope) => {
                          // Record the persist scope only for model settings —
                          // the reset effect is gated on the dialog/fallback/auth
                          // flags, so it never runs for the approvalMode dialog
                          // and would leave a stale scope behind.
                          if (key === 'fastModel') {
                            setModelSettingScope(scope);
                            setModelDialogMode('fast');
                          } else if (key === 'visionModel') {
                            setModelSettingScope(scope);
                            setModelDialogMode('vision');
                          } else if (key === 'voiceModel') {
                            // The voice picker opens asynchronously (after
                            // loadProviders), so DON'T record the scope up front:
                            // if the user opens and closes another picker while
                            // loading, the reset effect would clobber it and the
                            // voice model would persist to the wrong scope. Set
                            // the scope together with the open, from this click's
                            // captured `scope`, and only when no other surface
                            // opened meanwhile.
                            workspaceActions
                              .loadProviders()
                              .then((status) => {
                                setVoiceModels(extractVoiceModels(status));
                                // "No other surface opened meanwhile" — mirror the
                                // reset effect's condition so the voice picker
                                // never opens on top of a fallbacks/auth dialog.
                                if (
                                  modelDialogModeRef.current === null &&
                                  !showFallbacksDialogRef.current &&
                                  !showAuthDialogRef.current
                                ) {
                                  setModelSettingScope(scope);
                                  setModelDialogMode('voice');
                                }
                              })
                              .catch((error: unknown) =>
                                reportError(error, t('model.setVoice')),
                              );
                          } else if (key === 'modelFallbacks') {
                            setModelSettingScope(scope);
                            setShowFallbacksDialog(true);
                          } else if (key === 'tools.approvalMode') {
                            // Not a model setting — leave modelSettingScope alone.
                            setShowApprovalModeDialog(true);
                          }
                        }}
                      />
                    ) : activePanel === 'status' ? (
                      <DaemonStatusDialog />
                    ) : activePanel === 'extensions' ? (
                      <ExtensionsManagerPage
                        onClose={closePanel}
                        initialFocusRef={panelHeadingRef}
                      />
                    ) : activePanel === 'mcp' && mcpDialogMessage ? (
                      <McpManagerPage
                        message={mcpDialogMessage}
                        onClose={() => {
                          setMcpDialogMessage(null);
                          closePanel();
                        }}
                      />
                    ) : activePanel === 'skills' ? (
                      <SkillsManagerPage
                        onClose={closePanel}
                        onUseSkill={handleUseSkill}
                      />
                    ) : activePanel === 'plugins' ? (
                      <PluginManagerPage
                        mcpMessage={mcpDialogMessage}
                        loadMcpMessage={async () => {
                          try {
                            await loadMcpManagerMessage();
                          } catch (error) {
                            reportError(error, 'Failed to load MCP status');
                            throw error;
                          }
                        }}
                        onClose={closePanel}
                        onUseSkill={handleUseSkill}
                        initialFocusRef={pluginTabRef}
                      />
                    ) : (
                      <SessionOverviewPanel
                        onOpenSession={handleOpenSessionFromOverview}
                        onOpenSplit={openSplitView}
                        includeOtherWorkspaces={!lockedWorkspaceCwd}
                        workspaceCwd={lockedWorkspaceCwd}
                      />
                    )}
                  </div>
                </section>
              )}
              {mainView === 'scheduledTasks' && (
                <div
                  className={styles.fullPage}
                  data-testid="scheduled-tasks-page"
                >
                  <div className={styles.fullPageHeader}>
                    <button
                      type="button"
                      className={styles.fullPageBack}
                      onClick={() => setMainView('chat')}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <div className={styles.fullPageTitle}>
                      {t('scheduledTasks.title')}
                    </div>
                  </div>
                  <div className={styles.fullPageBody}>
                    <ScheduledTasksDialog
                      onRunPrompt={runTaskManually}
                      // Registered workspaces (multi-workspace daemons only) so
                      // the page aggregates every project's schedule and the New
                      // form can target one; absent/single → primary-only view.
                      workspaces={
                        lockedWorkspaceCwd
                          ? visibleWorkspaces
                          : workspaces
                      }
                      lockedWorkspace={lockedWorkspaceCapability}
                      onCreateViaChat={() => {
                        // Start a FRESH session and jump to it so the task-
                        // creation chat doesn't pile onto the current
                        // conversation, then prime the composer so the user can
                        // describe the task in natural language; the agent
                        // creates it via its cron_create tool. Focus is deferred
                        // so the new session's composer is mounted/visible first.
                        void createNewSession().then((created) => {
                          // If the new session couldn't be started,
                          // createNewSession already surfaced the error — do NOT
                          // prime the (still-current) session with the task
                          // starter, which would land in the wrong conversation.
                          if (!created) return;
                          onSessionIdChange?.(undefined);
                          window.setTimeout(() => {
                            editorRef.current?.insertText(
                              t('scheduledTasks.chatStarter'),
                              { mode: 'replace' },
                            );
                            editorRef.current?.focus();
                          }, 0);
                        });
                      }}
                      onOpenSession={(sessionId) => {
                        // The task's bound session IS its run history — switch
                        // to the chat view and load that session's transcript.
                        setMainView('chat');
                        loadSidebarSession(sessionId).catch(
                          (error: unknown) => {
                            reportError(error, 'Failed to open session');
                          },
                        );
                      }}
                      onError={reportError}
                    />
                  </div>
                </div>
              )}
              {mainView === 'goals' && (
                <div className={styles.fullPage} data-testid="goals-page">
                  <div className={styles.fullPageHeader}>
                    <button
                      type="button"
                      className={styles.fullPageBack}
                      onClick={() => setMainView('chat')}
                      aria-label={t('common.back')}
                      title={t('common.back')}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        width="18"
                        height="18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M15 18l-6-6 6-6" />
                      </svg>
                    </button>
                    <div className={styles.fullPageTitle}>
                      {t('goals.title')}
                    </div>
                  </div>
                  <div className={styles.fullPageBody}>
                    <GoalsDialog
                      onCreateGoal={async (condition) => {
                        // Setting a goal registers the Stop hook AND kicks off
                        // the first turn, so it has to travel the prompt path.
                        // Start a FRESH session so the goal loop doesn't take
                        // over the conversation the user was already having.
                        //
                        // Unless a previous attempt in this same visit to the
                        // page already made one and then failed to send: that
                        // session never got its goal and is still current, so
                        // reuse it. Creating another would strand it, and a user
                        // retrying a few times would end up with a column of
                        // blank chats in the sidebar.
                        //
                        // Leaving the page forgets it (see the effect on
                        // `strandedGoalSessionRef`), so this can never reuse a
                        // session the user has since talked to.
                        const stranded = strandedGoalSessionRef.current;
                        const canReuseStranded =
                          stranded !== undefined &&
                          connectionRef.current.sessionId === stranded;
                        if (!canReuseStranded) {
                          // `keepView`: createNewSession switches to the chat by
                          // default, which would unmount this form before the
                          // prompt is even sent and leave a later rejection with
                          // nowhere to render — the exact failure the deferred
                          // switch below exists to prevent.
                          const created = await createNewSession(undefined, {
                            keepView: true,
                          });
                          // createNewSession already surfaced the failure; don't
                          // drop the goal into the wrong (still-current) session.
                          // `false` keeps the form open with the typed condition
                          // still in it — returning normally would read as
                          // "created" and reset it.
                          if (!created) return false;
                          onSessionIdChange?.(undefined);
                        }
                        // Switch to the chat only once the prompt is admitted.
                        // Switching first unmounts the Goals page, and a later
                        // rejection would then have nowhere to render: the user
                        // would land in an empty session with no explanation.
                        // Letting this reject keeps the error in the form the
                        // user is looking at.
                        try {
                          await sendPrompt(`/goal ${condition}`, undefined, {
                            clearComposerOnPromptStart: true,
                          });
                        } catch (error) {
                          // `sendPrompt` creates the session lazily, so by now
                          // one may exist even though the prompt never landed.
                          // Remember it so the retry reuses it rather than
                          // stranding it.
                          strandedGoalSessionRef.current =
                            connectionRef.current.sessionId;
                          throw error;
                        }
                        strandedGoalSessionRef.current = undefined;
                        setMainView('chat');
                      }}
                      onOpenSession={(sessionId) => {
                        // The goal's session transcript IS its history.
                        setMainView('chat');
                        loadSidebarSession(sessionId).catch(
                          (error: unknown) => {
                            reportError(error, 'Failed to open session');
                          },
                        );
                      }}
                      onError={reportError}
                    />
                  </div>
                </div>
              )}
              {mainView === 'split' && (
                <div className={styles.fullPage} data-testid="split-view-page">
                  {/* The outer session's approval overlay is suppressed under the
                      split (it would own ghost keyboard shortcuts). If that
                      session isn't one of the panes, the approval would be
                      invisible — surface a notice with a way back to it. */}
                  {approvalOverlayActive && (
                    <div
                      className={styles.splitApprovalNotice}
                      role="status"
                      data-testid="split-approval-notice"
                    >
                      <span>{t('splitView.outerApprovalPending')}</span>
                      <button type="button" onClick={() => setMainView('chat')}>
                        {t('splitView.goToApproval')}
                      </button>
                    </div>
                  )}
                  {/* Share the app-level customization + compact-mode contexts so
                      split panes render markdown/tool-headers/thinking the same
                      way the single-session chat does (todo contexts stay chat-
                      only — they belong to the outer session, not the panes). */}
                  <WebShellCustomizationProvider value={customization}>
                    <CompactModeContext.Provider value={compactMode}>
                      <SplitView
                        sessionIds={splitSessionIds}
                        // Mirror live pane add/remove back up so switching away
                        // and re-entering restores the same panes. Keep this
                        // callback stable to avoid looping SplitView's reporting
                        // effect.
                        onPanesChange={handleSplitPanesChange}
                        // Refresh the "add pane" picker when the session list
                        // changes elsewhere, matching the sidebar.
                        sessionListReloadToken={sessionListReloadToken}
                        includeOtherWorkspaces={!lockedWorkspaceCwd}
                        workspaceCwd={lockedWorkspaceCwd}
                        // Back returns to the Session Overview (the hub the split
                        // is launched from), not the single-session chat.
                        onExit={handleSplitExit}
                        onError={reportError}
                        onSlashCommand={onSlashCommand}
                        onRightPanelOpen={handleTurnOutputOpen}
                        onPaneArtifactsChange={handlePaneArtifactsChange}
                        messageTurnOutputs={messageTurnOutputs}
                        restartSseOnPrompt={restartSseOnPrompt}
                      />
                    </CompactModeContext.Provider>
                  </WebShellCustomizationProvider>
                </div>
              )}
              <div
                className={[
                  styles.chatViewWrap,
                  hasMobileComposerBottom
                    ? styles.chatViewWithMobileComposerBottom
                    : undefined,
                  hasWelcomeMiddle
                    ? styles.chatViewWithWelcomeMiddle
                    : undefined,
                  activePanel || mainView !== 'chat'
                    ? styles.chatViewHidden
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' ')}
                // Hide the outer chat whenever a panel or a full-page view (split
                // / scheduled tasks) is up. `display:none` drops the subtree from
                // layout and the tab order, and aria-hidden keeps AT out — so no
                // keyboard/AT can reach the outer composer/toolbar behind the
                // split. State is preserved (the node stays mounted).
                aria-hidden={
                  activePanel || mainView !== 'chat' ? true : undefined
                }
              >
                {showMissingSessionState && (
                  <div className={styles.missingSessionState}>
                    <div className={styles.missingSessionMessage}>
                      {t('session.missing')}
                    </div>
                    <button
                      type="button"
                      className={styles.missingSessionButton}
                      disabled={isCreatingMissingSession}
                      onClick={handleMissingSessionNewSession}
                    >
                      {t('session.new')}
                    </button>
                  </div>
                )}
                <div
                  className={
                    showMissingSessionState
                      ? styles.chatSubtreeHidden
                      : styles.chatSubtree
                  }
                >
                  <WebShellCustomizationProvider value={customization}>
                    <CompactModeContext.Provider value={compactMode}>
                      <TodoContextsProvider
                        timeline={todoTimeline}
                        details={todoDetails}
                      >
                        <InteractionBlockContext.Provider
                          value={registerInteractionBlocker}
                        >
                          {(() => {
                            const contentClassName = [
                              styles.content,
                              showFloatingTodos ||
                              displayMessages.length > 0 ||
                              pendingApproval
                                ? styles.contentHasMessages
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(' ');

                            const messageList = (
                              <MessageList
                                ref={messageListRef}
                                messages={displayMessages}
                                pendingApproval={pendingToolApproval}
                                onShowContextDetail={handleShowContextDetail}
                                loadingTranscript={connection.loadingTranscript}
                                catchingUp={connection.catchingUp}
                                hasOlderHistory={transcriptHistory.hasMore}
                                loadingOlderHistory={transcriptHistory.loading}
                                historyCapacityReached={
                                  transcriptHistory.capacityReached
                                }
                                onLoadOlderHistory={transcriptHistory.loadMore}
                                isResponding={streamingState !== 'idle'}
                                activeTurnStartedAt={activeTurnStartedAt}
                                workspaceCwd={connection.workspaceCwd || ''}
                                hideSessionTimeline={
                                  effectiveChatWidthMode === 'wide'
                                }
                                showRetryHint={showRetryHint}
                                onRetryClick={handleRetry}
                                onBranchSession={handleBranchCurrentSession}
                                bottomOverlayInset={bottomPanelInset}
                                welcomeHeader={
                                  isChatEmptyState ? welcomeHeader : undefined
                                }
                                centerWelcomeHeader={
                                  showMobileWelcomeFooterMiddle || undefined
                                }
                                tailContent={undefined}
                                tailKey={undefined}
                                onCanScrollToBottomChange={
                                  handleCanScrollToBottomChange
                                }
                                virtualScrollThreshold={virtualScrollThreshold}
                                turnFileChanges={
                                  visibleTurnOutputKinds.has('file')
                                    ? fileChangesByTurn
                                    : undefined
                                }
                                turnArtifacts={
                                  visibleTurnOutputKinds.has('artifact')
                                    ? artifactsByTurn
                                    : undefined
                                }
                                turnScheduledTasks={
                                  visibleTurnOutputKinds.has('scheduled_task')
                                    ? scheduledTasksByTurn
                                    : undefined
                                }
                                onTurnOutputOpen={handleTurnOutputOpen}
                                onReviewChanges={openReviewPanel}
                                onOpenArtifact={openArtifactPanel}
                                onOpenScheduledTask={openScheduledTaskPanel}
                                generateContent={
                                  connection.capabilities?.features.includes(
                                    'session_generation',
                                  )
                                    ? sessionActions.generateSessionContent
                                    : undefined
                                }
                              />
                            );

                            const btwPanel =
                              !showMobileWelcomeFooterMiddle &&
                              btwMessage?.role === 'btw' ? (
                                <div className={styles.btwPanel}>
                                  <BtwMessage
                                    question={btwMessage.question}
                                    answer={btwMessage.answer}
                                    isPending={btwMessage.isPending}
                                  />
                                </div>
                              ) : null;

                            if (showMobileWelcomeFooterMiddle) {
                              return (
                                <div className={styles.mobileWelcomeGroup}>
                                  <div
                                    style={contentStyle}
                                    className={contentClassName}
                                  >
                                    {messageList}
                                    {btwPanel}
                                  </div>
                                  <div
                                    className={styles.mobileWelcomeFooterMiddle}
                                  >
                                    {welcomeFooter}
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div
                                style={contentStyle}
                                className={contentClassName}
                              >
                                {messageList}
                                {btwPanel}
                              </div>
                            );
                          })()}
                        </InteractionBlockContext.Provider>
                      </TodoContextsProvider>
                    </CompactModeContext.Provider>

                    <div
                      ref={footerRef}
                      style={contentStyle}
                      className={
                        CustomFooter
                          ? `${styles.footer} ${styles.footerWithCustomFooter}`
                          : styles.footer
                      }
                    >
                      {canScrollMessageListToBottom && (
                        <div
                          className={
                            showBottomPanels
                              ? `${styles.scrollToBottomLayer} ${styles.scrollToBottomLayerWithTodos}`
                              : styles.scrollToBottomLayer
                          }
                        >
                          <button
                            type="button"
                            className={styles.scrollToBottomButton}
                            aria-label={t('chat.scrollToBottom')}
                            onClick={() => resumeChatBottomFollow('smooth')}
                          >
                            <svg
                              className={styles.scrollToBottomIcon}
                              viewBox="0 0 24 24"
                              aria-hidden="true"
                            >
                              <path
                                d="M12 5v13M6.5 12.5 12 18l5.5-5.5"
                                fill="none"
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                        </div>
                      )}
                      {showBottomPanels && (
                        <div
                          ref={bottomPanelsRef}
                          className={styles.bottomPanels}
                        >
                          <TodoPanel
                            todos={showFloatingTodos ? floatingTodos : []}
                            statusItems={floatingBottomStatusItems}
                          />
                        </div>
                      )}
                      {/* Only render the outer session's approval on the chat
                          view. Under a full-page view (split / scheduled tasks)
                          it would sit hidden and unreachable. Each split pane
                          surfaces its own approval. `keyboardActive` tells the
                          overlay to grab focus only when it's the topmost one. */}
                      {pendingToolApproval && mainView === 'chat' && (
                        <div
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <ToolApproval
                            request={pendingToolApproval}
                            onConfirm={handleConfirm}
                            variant="floating"
                            keyboardActive={toolApprovalOverlayVisible}
                          />
                        </div>
                      )}
                      {pendingAskUserApproval && mainView === 'chat' && (
                        <div
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <AskUserQuestion
                            request={pendingAskUserApproval}
                            onConfirm={handleConfirm}
                            variant="floating"
                            keyboardActive={askUserOverlayVisible}
                          />
                        </div>
                      )}
                      <div className={styles.composer}>
                        {streamingState !== 'idle' ? (
                          <StreamingStatus startedAt={activeTurnStartedAt} />
                        ) : newSessionSuggestion ? (
                          <div
                            className={styles.composerActionTip}
                            role="status"
                            data-testid="new-session-suggestion"
                          >
                            <span
                              className={styles.composerActionTipIcon}
                              aria-hidden="true"
                            >
                              ✦
                            </span>
                            <span className={styles.composerActionTipText}>
                              {t('editor.newSessionSuggestionTitle')}
                            </span>
                            <div className={styles.composerActionTipActions}>
                              <button
                                type="button"
                                className={`${styles.composerActionTipButton} ${styles.composerActionTipButtonPrimary}`}
                                data-testid="new-session-suggestion-start"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={handleAcceptNewSessionSuggestion}
                              >
                                {t('editor.newSessionSuggestionStart')}
                              </button>
                            </div>
                          </div>
                        ) : escapeHintVisible && streamingState === 'idle' ? (
                          <div className={styles.escClearStatus} role="status">
                            {t('editor.escClearHint')}
                          </div>
                        ) : null}
                        <QueuedPromptDisplay
                          prompts={queuedPrompts}
                          t={t}
                          onDelete={removeQueuedPrompt}
                          onInsert={insertQueuedPrompt}
                          onEdit={editQueuedPrompt}
                        />
                        {CustomComposerHeader && (
                          <div className={styles.composerHeader}>
                            <CustomComposerHeader
                              disabled={isDisabled}
                              isRunning={streamingState !== 'idle'}
                              currentMode={currentMode}
                              currentModel={currentModel}
                              sessionName={sessionDisplayName}
                            />
                          </div>
                        )}
                        <ChatEditor
                          ref={setEditorHandle}
                          onSubmit={handleEditorSubmit}
                          onInputTextChange={handleComposerTextChange}
                          onCycleMode={handleCycleMode}
                          onToggleShortcuts={handleToggleShortcuts}
                          onCancel={handleCancel}
                          isRunning={streamingState !== 'idle'}
                          isPreparing={
                            isPreparingPrompt || isStartingNewSessionSuggestion
                          }
                          cancelArmed={cancelArmed}
                          disabled={
                            isDisabled || isStartingNewSessionSuggestion
                          }
                          commands={commands}
                          skills={loadedSkills}
                          slashCommandCategoryOrder={slashCommandCategoryOrder}
                          builtinAtProviders={builtinAtProviders}
                          atProviders={atProviders}
                          composerTagIcons={composerTagIcons}
                          queuedMessages={queuedTexts}
                          onFocusFooter={handleFocusTaskPill}
                          onPopQueuedMessages={editLastQueuedPrompt}
                          onClearQueuedMessages={clearQueuedPrompts}
                          currentMode={currentMode}
                          currentModel={currentModel}
                          gitBranch={
                            sessionWorktree
                              ? (selectedWorkspaceGitStatus?.branch ??
                                sessionWorktree.branch)
                              : (connection.sessionId
                                ? connection.gitBranch
                                : (selectedWorkspaceGitStatus?.branch ??
                                  undefined))
                          }
                          gitWorktree={Boolean(sessionWorktree)}
                          gitStatus={selectedWorkspaceGitStatus}
                          onOpenGitDiff={
                            gitDiffWorkspaceCwd && !sessionWorktree
                              ? () =>
                                  setGitDialog({
                                    workspaceCwd: gitDiffWorkspaceCwd,
                                    view: 'diff',
                                  })
                              : undefined
                          }
                          chatWidthMode={chatWidthMode}
                          showChatWidthToggle={!isChatEmptyState}
                          chatWidthToggleMin={chatWidthToggleMin}
                          visibleToolbarActions={composerToolbarActions}
                          availableModels={availableModels}
                          onSelectMode={handleSetMode}
                          onSelectModel={handleModelSelect}
                          workspaces={
                            !lockedWorkspaceCwd && workspaces.length > 1
                              ? workspaces.map((entry) => ({
                                    id: entry.id,
                                    cwd: entry.cwd,
                                    label: workspaceLabel(entry),
                                    primary: entry.primary,
                                  }))
                              : undefined
                          }
                          selectedWorkspaceCwd={
                            connection.sessionId
                              ? workspaces.find(
                                  (entry) =>
                                    entry.cwd === connection.workspaceCwd,
                                )?.primary
                                ? undefined
                                : connection.workspaceCwd
                              : selectedWorkspaceCwd
                          }
                          workspaceSelectionDisabled={Boolean(
                            connection.sessionId,
                          )}
                          atWorkspaceCwd={
                            lockedWorkspaceCwd ??
                            (connection.sessionId
                              ? connection.workspaceCwd
                              : (selectedWorkspaceCwd ??
                                workspaces.find((entry) => entry.primary)?.cwd))
                          }
                          onSelectWorkspace={(cwd) => {
                            selectedWorkspaceCwdRef.current = cwd;
                            setSelectedWorkspaceCwd(cwd);
                          }}
                          onChatWidthModeChange={handleChatWidthModeChange}
                          sessionName={sessionDisplayName}
                          dialogOpen={
                            interactionBlocked || approvalOverlayActive
                          }
                          followupState={followupState}
                          onAcceptFollowup={onAcceptFollowup}
                          onDismissFollowup={onDismissFollowup}
                          composerInput={composerInput}
                          composerInputVersion={composerInputVersion}
                          placeholderText={composerPlaceholderText}
                        />
                      </div>
                      {CustomFooter ? (
                        hasMobileComposerBottom ? (
                          <div className={styles.customFooter}>
                            <CustomFooter
                              connected={connected}
                              mode={currentMode}
                              model={currentModel}
                              streamingState={streamingState}
                              contextUsageRatio={
                                (connection.contextWindow ?? 0) > 0
                                  ? (connection.tokenCount ?? 0) /
                                    (connection.contextWindow ?? 0)
                                  : 0
                              }
                              activeGoal={activeGoal}
                              tasks={footerTasks}
                              availableModes={MODES_CYCLE}
                              availableModels={(connection.models ?? [])
                                .filter(isVisibleComposerModel)
                                .map((m) => ({
                                  id: m.id,
                                  label: getModelDisplayName(m.label || m.id),
                                  contextWindow: m.contextWindow,
                                }))}
                              skills={loadedSkills}
                              onSelectMode={handleSetMode}
                              onSelectModel={handleModelSelect}
                            />
                          </div>
                        ) : (
                          <CustomFooter
                            connected={connected}
                            mode={currentMode}
                            model={currentModel}
                            streamingState={streamingState}
                            contextUsageRatio={
                              (connection.contextWindow ?? 0) > 0
                                ? (connection.tokenCount ?? 0) /
                                  (connection.contextWindow ?? 0)
                                : 0
                            }
                            activeGoal={activeGoal}
                            tasks={footerTasks}
                            availableModes={MODES_CYCLE}
                            availableModels={(connection.models ?? [])
                              .filter(isVisibleComposerModel)
                              .map((m) => ({
                                id: m.id,
                                label: getModelDisplayName(m.label || m.id),
                                contextWindow: m.contextWindow,
                              }))}
                            skills={loadedSkills}
                            onSelectMode={handleSetMode}
                            onSelectModel={handleModelSelect}
                          />
                        )
                      ) : (
                        <StatusBar
                          onSelectMode={() =>
                            setShowApprovalModeDialog((v) => !v)
                          }
                          onSelectModel={() =>
                            setModelDialogMode((v) => (v ? null : 'main'))
                          }
                          onShowContext={() =>
                            showContextUsage('/context', false)
                          }
                          onOpenSettings={() => openPanel('settings')}
                          ref={statusBarRef}
                          onOpenTasks={() => openTasksPanel()}
                          onReturnToInput={handleReturnToEditor}
                          tasks={backgroundTasks}
                          activeGoal={activeGoal}
                          onOpenGoals={openGoals}
                          hideSettings={hideSettings}
                          onToggleShortcuts={handleToggleShortcuts}
                          compact={true}
                        />
                      )}
                      {isChatEmptyState && welcomeFooter && (
                        <div
                          className={[
                            styles.emptyWelcomeFooter,
                            showMobileWelcomeFooterMiddle
                              ? styles.desktopWelcomeFooter
                              : undefined,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          {welcomeFooter}
                        </div>
                      )}
                    </div>
                  </WebShellCustomizationProvider>
                </div>
              </div>
            </div>
            {artifactPanelOpen && (
              <>
                <div
                  className={styles.artifactResizeHandle}
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={MIN_ARTIFACT_PANEL_WIDTH}
                  aria-valuemax={getMaxArtifactPanelWidth()}
                  aria-valuenow={artifactPanelWidth}
                  onPointerDown={handleArtifactPanelResizeStart}
                />
                <ArtifactPanel
                  artifacts={artifactPanelArtifacts}
                  tabs={artifactPanelTabs}
                  activeTabId={activeArtifactPanelTabId}
                  reviewChanges={reviewChanges}
                  selectedReviewPath={selectedReviewPath}
                  panelWidth={artifactPanelWidth}
                  workspaceCwd={connection.workspaceCwd || ''}
                  loading={artifactsLoading}
                  error={artifactsError}
                  onSelectTab={setActiveArtifactPanelTabId}
                  onCloseTab={closeArtifactPanelTab}
                  onClose={closeArtifactPanel}
                />
              </>
            )}
          </div>
        </div>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    </ThemeProvider>
  );
}

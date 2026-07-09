import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  DAEMON_APPROVAL_MODES,
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useSettings,
  useSessionNotices,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptStore,
  useWorkspaceActions,
  useWorkspaceEventSignals,
  type DaemonSessionNotice,
  type DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import { isDaemonTurnError } from '@qwen-code/sdk/daemon';
import type {
  DaemonTranscriptBlock,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
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
import {
  AgentsMessage,
  type AgentsInitialMode,
} from './components/messages/AgentsMessage';
import { MemoryMessage } from './components/messages/MemoryMessage';
import { AuthMessage } from './components/messages/AuthMessage';
import { ToolsDialog } from './components/dialogs/ToolsDialog';
import { DaemonStatusDialog } from './components/dialogs/DaemonStatusDialog';
import { SessionOverviewPanel } from './components/SessionOverviewPanel';
import { SplitView } from './components/SplitView';
import { useIsLargeScreen } from './hooks/useIsLargeScreen';
import { MAX_SPLIT_PANES, parseSplitSessionIds } from './utils/splitUrl';
import { ScheduledTasksDialog } from './components/dialogs/ScheduledTasksDialog';
import { ExtensionsDialog } from './components/dialogs/ExtensionsDialog';
import { SettingsMessage } from './components/messages/SettingsMessage';
import { isAskUserPermission } from './utils/askUserPermission';
import { ToolApproval } from './components/messages/ToolApproval';
import { AskUserQuestion } from './components/messages/AskUserQuestion';
import { HelpDialog } from './components/dialogs/HelpDialog';
import { ThemeDialog } from './components/dialogs/ThemeDialog';
import { DeleteSessionDialog } from './components/dialogs/DeleteSessionDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { RewindDialog } from './components/dialogs/RewindDialog';
import { WebShellSidebar } from './components/sidebar/WebShellSidebar';
import {
  getLocalCommands,
  localizeBuiltinDescriptions,
  skillDescriptionKey,
} from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameValue } from './hooks/useAnimationFrameValue';
import { useBackgroundTasks } from './hooks/useBackgroundTasks';
import { useMessages } from './hooks/useMessages';
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
import { McpDialog } from './components/dialogs/McpDialog';
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
  shouldBlockComposerSubmit,
  shouldDisableComposerInput,
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
import {
  WebShellThemeId,
  THEME_SETTING_KEY,
  LANGUAGE_SETTING_KEY,
  themeSettingToWebShellTheme,
  type WebShellTheme,
} from './themeContext';
import {
  WebShellCustomizationProvider,
  type WebShellComposerApi,
  type WebShellComposerInput,
  type WebShellMarkdownCustomization,
  type ToolHeaderExtraRenderer,
  type UserMessageContentRenderer,
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
  type WebShellComposerTagIconMap,
} from './customization';
import type { CommandDisplayCategoryOrder } from './utils/commandDisplay';
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
// Cap on how long a manual "run now" waits for its bound session to become
// active before giving up, so the scheduled-tasks UI can't stay stuck disabled
// if the switch never completes.
const BOUND_RUN_SWITCH_TIMEOUT_MS = 30_000;

function availableSkillInfos(status: {
  skills?: Array<{ status?: string; name: string; description?: string }>;
}): SkillInfo[] {
  return (status.skills ?? [])
    .filter((skill) => skill.status === 'ok')
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
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

// Keep in sync with CLEAR_KEYWORDS in packages/cli/src/ui/commands/goalCommand.ts
const GOAL_CLEAR_KEYWORDS = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
]);

function isGoalClearCommand(text: string): boolean {
  const goalArg = text
    .replace(/^\/goal\b/i, '')
    .trim()
    .toLowerCase();
  return GOAL_CLEAR_KEYWORDS.has(goalArg);
}

interface ActiveGoalStatus {
  condition: string;
  setAt: number;
}

interface SendPromptOptionsWithRetry {
  optimisticUserMessage?: boolean;
  images?: PromptImage[];
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
}

export interface WebShellProps {
  /** Called whenever the attached daemon session id changes. */
  onSessionIdChange?: (sessionId: string | undefined) => void;
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
  /** Imperative handle for externally opening WebShell surfaces. */
  shellRef?: React.Ref<WebShellApi>;
  /** Built-in composer toolbar actions to show. Defaults to all actions. */
  composerToolbarActions?: readonly ComposerToolbarAction[];
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
  /** Show renderWelcomeFooter between the welcome header and composer on mobile empty state. */
  mobileWelcomeFooterMiddle?: boolean;
  /** Custom renderer for the inside of user chat bubbles. Defaults to plain text. */
  renderUserMessageContent?: UserMessageContentRenderer;
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

type SessionActionsWithCreate = {
  createSession: () => Promise<{ sessionId: string }>;
  attachSession: () => Promise<void>;
  closeSession: () => Promise<void>;
  clearSession: () => Promise<void>;
};

const emptyComposerApi: WebShellComposerApi = {
  insertText: () => {},
  setText: () => {},
  addTags: () => {},
  removeTag: () => {},
  clear: () => {},
  submit: () => {},
};

const DEFAULT_CHAT_MAX_WIDTH = 1000;
type ChatWidthMode = `${typeof DEFAULT_CHAT_MAX_WIDTH}` | 'wide';

const CHAT_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-chat-width';
const CHAT_SHELL_HORIZONTAL_PADDING = 40;
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'qwen-code-web-shell-sidebar-collapsed';

function resolveSidebarOptions(
  sidebar: WebShellProps['sidebar'],
): Required<WebShellSidebarOptions> {
  if (sidebar === true) {
    return { enabled: true, defaultCollapsed: false };
  }
  if (!sidebar) {
    return { enabled: false, defaultCollapsed: false };
  }
  return {
    enabled: sidebar.enabled ?? true,
    defaultCollapsed: sidebar.defaultCollapsed ?? false,
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

export function App({
  onSessionIdChange,
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
  atProviders,
  composerTagIcons,
  renderToolHeaderExtra,
  renderWelcomeHeader,
  renderWelcomeFooter,
  mobileWelcomeFooterMiddle = false,
  renderUserMessageContent,
  renderComposerToolbarStart,
  renderComposerToolbarEnd,
  renderComposerToolbarRight,
  renderComposerHeader,
  renderFooter,
  chatMaxWidth,
  sidebar,
  splitSessionIds: externalSplitSessionIds,
  onSplitSessionIdsChange,
  shellRef,
  composerToolbarActions,
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
}: WebShellProps = {}) {
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
  const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), []);
  // The Session Overview panel (mission control for managing many sessions at
  // once) is only offered on large screens; below that there is no room for it
  // to be useful.
  const isLargeScreen = useIsLargeScreen();

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 760px)');
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) setMobileDrawerOpen(false);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

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
  const customization = useMemo(
    () => ({
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      renderUserMessageContent,
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
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      renderUserMessageContent,
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
  const sessionActions = useActions();
  const { notices, dismissNotice } = useSessionNotices();
  const workspaceActions = useWorkspaceActions();
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
  const currentSessionIdRef = useRef(connection.sessionId);
  const lastNotifiedSessionIdRef = useRef<string | undefined>(undefined);
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
  const footerRef = useRef<HTMLDivElement>(null);
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
  const [loadedSkills, setLoadedSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    if (!connected) return;
    workspaceActions
      .loadSkillsStatus()
      .then((status) => {
        setLoadedSkills(availableSkillInfos(status));
      })
      .catch(() => {});
  }, [connected, workspaceActions]);

  const [modelDialogMode, setModelDialogMode] =
    useState<ModelDialogMode | null>(null);
  const [voiceModels, setVoiceModels] = useState<VoiceModelOption[]>([]);
  const [showApprovalModeDialog, setShowApprovalModeDialog] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [showRewindDialog, setShowRewindDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showToolsDialog, setShowToolsDialog] = useState(false);
  // Main content view. The scheduled-tasks page replaces the chat pane inline
  // (not a modal overlay), mirroring the reference design; creating or opening
  // a chat returns to 'chat'. (Daemon Status is no longer a boolean dialog — it
  // is one of the activePanel values below.)
  const [mainView, setMainView] = useState<'chat' | 'scheduledTasks' | 'split'>(
    'chat',
  );
  // Sessions to seed the split view with (e.g. the selection from the overview).
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>([]);
  const [showExtensionsDialog, setShowExtensionsDialog] = useState(false);
  const [mcpDialogMessage, setMcpDialogMessage] =
    useState<SerializedMcpStatusMessage | null>(null);
  // Settings and Daemon Status are shown as an in-place panel that replaces the
  // chat view (message list + composer), not as a modal overlay. Only one may be
  // active at a time; null means the normal chat view is shown.
  const [activePanel, setActivePanel] = useState<
    'settings' | 'status' | 'sessions' | null
  >(null);
  const closePanel = useCallback(() => setActivePanel(null), []);
  // The Settings/Status panel (activePanel) and the Scheduled Tasks page
  // (mainView) are mutually-exclusive full-pane views — the latter is a
  // position:absolute overlay that would otherwise cover the former — so opening
  // one closes the other. Without this, opening Scheduled Tasks then Daemon
  // Status left the panel rendered behind the Scheduled Tasks overlay, looking
  // like the button did nothing.
  const openPanel = useCallback((panel: 'settings' | 'status' | 'sessions') => {
    setMainView('chat');
    setActivePanel(panel);
  }, []);
  const openScheduledTasks = useCallback(() => {
    setActivePanel(null);
    setMainView('scheduledTasks');
  }, []);
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
  const shellApi = useMemo<WebShellApi>(
    () => ({
      openSplitView: () => requestOpenSplitView(),
      openSessionOverview: () => openPanel('sessions'),
    }),
    [openPanel, requestOpenSplitView],
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
    openPanel('sessions');
  }, [notifyControlledSplitClose, openPanel]);
  // A `?split=a,b` URL (opened in a new tab from the overview) enters the split
  // view with those sessions on load. Consume the param once so a later reload
  // or exit doesn't force the split back on.
  useEffect(() => {
    const ids = parseSplitSessionIds(window.location.search);
    if (ids.length === 0) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('split');
    window.history.replaceState(null, '', url);
    if (!externalSplitControlled) {
      openSplitView(ids);
    }
  }, [externalSplitControlled, openSplitView]);
  // If the viewport shrinks below the large-screen breakpoint, close the Session
  // Overview panel and the split view — both are large-screen-only surfaces
  // whose entry points are hidden on small screens, so leaving them up would
  // strand the user in a view they can no longer re-enter.
  // When a shrink closes the split, its panes unmount and take keyboard focus
  // with them; flag the composer to be refocused once the chat is shown again.
  const focusComposerAfterSplitCloseRef = useRef(false);
  useEffect(() => {
    if (!isLargeScreen && activePanel === 'sessions') {
      setActivePanel(null);
    }
    if (!isLargeScreen && mainView === 'split') {
      notifyControlledSplitClose();
      setMainView('chat');
      focusComposerAfterSplitCloseRef.current = true;
    }
  }, [isLargeScreen, activePanel, mainView, notifyControlledSplitClose]);
  // Land focus on the composer after a shrink-driven split close so keyboard
  // users aren't dropped onto <body> — but not when the chat now shows an
  // approval overlay (it owns the keyboard) or a panel (its Back self-focuses).
  useEffect(() => {
    if (mainView !== 'chat' || !focusComposerAfterSplitCloseRef.current) return;
    focusComposerAfterSplitCloseRef.current = false;
    if (!activePanel && !approvalOverlayActive) editorRef.current?.focus();
  }, [mainView, activePanel, approvalOverlayActive]);
  // The Settings / Daemon Status panel is a view, not a modal, so it lacks
  // DialogShell's focus trap/restore. Move focus to the Back button when a panel
  // opens (or when switching directly between panels) and back to the composer
  // when it closes, so keyboard users aren't stranded on an element that is
  // about to be hidden.
  const panelBackRef = useRef<HTMLButtonElement | null>(null);
  const prevActivePanelRef = useRef(activePanel);
  const prevApprovalOverlayRef = useRef(approvalOverlayActive);
  useEffect(() => {
    const prev = prevActivePanelRef.current;
    const wasApprovalActive = prevApprovalOverlayRef.current;
    prevActivePanelRef.current = activePanel;
    prevApprovalOverlayRef.current = approvalOverlayActive;
    if (activePanel) {
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
    // The Scheduled Tasks page is a full-pane overlay (position:absolute) that
    // covers the chat footer too, so dismiss it for the same reason. The split
    // view is deliberately NOT dismissed: each pane owns and renders its own
    // session's approval, so an approval on the (outer) main session must not
    // yank the user out of the panes they are working in.
    if (mainView === 'scheduledTasks') setMainView('chat');
  }, [
    approvalOverlayActive,
    activePanel,
    modelDialogMode,
    showApprovalModeDialog,
    mainView,
  ]);
  // Once the effect above uncovers the approval, the overlay is the topmost
  // surface but the just-unmounted panel Back button dropped focus to <body>.
  // Move focus onto the overlay when it becomes visible so keyboard/AT users
  // land on it. Only for ToolApproval: it drives keyboard entirely through a
  // window listener, so focusing its (tabindex=-1) wrapper is safe and gives AT
  // a landing spot without confirming (Enter arms first, confirms second — a
  // focused button would confirm on the first press). AskUserQuestion instead
  // manages its own focus across its options/input, so stealing focus to the
  // wrapper would break its arrow-key navigation.
  const approvalOverlayRef = useRef<HTMLDivElement | null>(null);
  const toolApprovalOverlayVisible =
    pendingToolApproval !== null &&
    !activePanel &&
    modelDialogMode === null &&
    !showApprovalModeDialog &&
    mainView === 'chat';
  const prevToolApprovalOverlayVisibleRef = useRef(toolApprovalOverlayVisible);
  useEffect(() => {
    const wasVisible = prevToolApprovalOverlayVisibleRef.current;
    prevToolApprovalOverlayVisibleRef.current = toolApprovalOverlayVisible;
    if (toolApprovalOverlayVisible && !wasVisible) {
      approvalOverlayRef.current?.focus();
    }
  }, [toolApprovalOverlayVisible]);
  const [showMemoryDialog, setShowMemoryDialog] = useState(false);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [memoryRefreshSignal, setMemoryRefreshSignal] = useState(0);
  const [memoryAddSignal, setMemoryAddSignal] = useState(0);

  // Refresh commands when extensions change (install/uninstall/update).
  const workspaceEventSignals = useWorkspaceEventSignals();
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
  useEffect(() => {
    if (connection.sessionId) {
      createSessionPromiseRef.current = null;
    }
  }, [connection.sessionId]);
  const ensureSessionForPrompt = useCallback(() => {
    if (connectionRef.current.sessionId) return Promise.resolve();
    if (!createSessionPromiseRef.current) {
      createSessionPromiseRef.current = (async () => {
        const modelId =
          currentModelRef.current || connectionRef.current.currentModel;
        const modeId =
          currentModeRef.current || connectionRef.current.currentMode;
        await createAndAttachSessionForPrompt({
          sessionActions: sessionActions as typeof sessionActions &
            SessionActionsWithCreate,
          modelId,
          modeId,
        });
      })().catch((error: unknown) => {
        createSessionPromiseRef.current = null;
        throw error;
      });
    }
    return createSessionPromiseRef.current;
  }, [sessionActions]);
  const onSubmitBeforeRef = useRef(onSubmitBefore);
  onSubmitBeforeRef.current = onSubmitBefore;
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
  const dialogOpen =
    showResumeDialog ||
    showDeleteDialog ||
    showReleaseDialog ||
    showRewindDialog ||
    showHelpDialog ||
    showThemeDialog ||
    showToolsDialog ||
    showExtensionsDialog ||
    modelDialogMode !== null ||
    showApprovalModeDialog ||
    tasksDialogMessage !== null ||
    mcpDialogMessage !== null ||
    agentsDialogMode !== null ||
    showMemoryDialog ||
    showAuthDialog ||
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
    ) => {
      if (onSubmitBeforeRef.current) {
        onSubmitBeforeRef
          .current({
            sessionId: connectionRef.current.sessionId,
            prompt: text,
          })
          .then(() => {
            const result = rawEnqueuePrompt(text, images, onComplete);
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
      const result = rawEnqueuePrompt(text, images, onComplete);
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
    const value = workspaceSettings.find(
      (setting) => setting.key === 'voiceModel',
    )?.values.effective;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
  const currentVisionModel = (() => {
    const value = workspaceSettings.find(
      (setting) => setting.key === 'visionModel',
    )?.values.effective;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return decodeVisionModelForPicker(value.trim());
  })();
  const currentFastModel = (() => {
    const value = workspaceSettings.find(
      (setting) => setting.key === 'fastModel',
    )?.values.effective;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  })();
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
    (nextLanguage: WebShellLanguage) => {
      const previousLanguage = selectedLanguage;
      const command = `/language ui ${nextLanguage}`;
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
      return;
    }
    if (lastNotifiedSessionIdRef.current === connection.sessionId) return;
    lastNotifiedSessionIdRef.current = connection.sessionId;
    onSessionIdChange?.(connection.sessionId);
  }, [connection.missingSession, connection.sessionId, onSessionIdChange]);

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

  const createNewSession = useCallback(async () => {
    // Close the drawer before awaiting so a failed createSession() doesn't leave
    // it stuck open with the page scroll still locked, matching loadSidebarSession.
    closeMobileDrawer();
    // Starting a new chat means the user wants to see it — leave any open
    // Settings/Status panel so the fresh chat is visible (no-op when closed).
    closePanel();
    try {
      await (
        sessionActions as typeof sessionActions & SessionActionsWithCreate
      ).clearSession();
      return true;
    } catch (error) {
      reportError(error, 'Failed to start a new chat');
      return false;
    }
  }, [closeMobileDrawer, closePanel, reportError, sessionActions]);
  const handleMissingSessionNewSession = useCallback(async () => {
    if (creatingMissingSessionRef.current) return;
    creatingMissingSessionRef.current = true;
    setIsCreatingMissingSession(true);
    setMainView('chat');
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
    async (sessionId: string) => {
      setSidebarSwitchingSessionId(sessionId);
      // Close the drawer before awaiting the load; the transcript clears
      // immediately and shows its loading skeleton for the selected session.
      closeMobileDrawer();
      // Loading another session should reveal its chat, not stay on the
      // Settings/Status panel (no-op when the panel is closed).
      closePanel();
      try {
        await sessionActions.loadSession(sessionId);
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

  useEffect(() => {
    if (
      sidebarSwitchingSessionId !== null &&
      connection.sessionId === sidebarSwitchingSessionId &&
      !connection.loadingTranscript &&
      !connection.catchingUp
    ) {
      setSidebarSwitchingSessionId(null);
    }
  }, [
    connection.catchingUp,
    connection.loadingTranscript,
    connection.sessionId,
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
      const goalArg = text.replace(/^\/goal\b/i, '').trim();
      const lowerGoalArg = goalArg.toLowerCase();
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

      if (goalArg && GOAL_CLEAR_KEYWORDS.has(lowerGoalArg)) {
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

      if (sendToDaemon) {
        return sendGoalPrompt();
      }
      store.appendLocalUserMessage(text);
      return true;
    },
    [
      dispatchGoalCleared,
      dispatchGoalSet,
      handleBusyGoalClear,
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
    ) => {
      if (connectionRef.current.loadingTranscript) {
        pushToast('warning', t('editor.sessionLoading'));
        return false;
      }
      if (
        shouldBlockComposerSubmit({
          connectionStatus: connectionRef.current.status,
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
        opts?: { optimisticUserMessage?: boolean; retry?: boolean },
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
        const match = text.match(/^\/([\w-]+)/);
        if (match) {
          const cmd = match[1];
          if (hiddenCommands.has(normalizeHiddenCommand(cmd))) {
            if (promptBlocked) {
              return enqueuePrompt(
                text,
                images,
                undefined,
                commitComposerAccepted,
              );
            }
            return submitPromptFromEditor(
              text,
              images,
              'Failed to send hidden slash command',
            );
          }
          if (cmd === 'help') {
            setShowHelpDialog(true);
            return true;
          }
          if (cmd === 'tasks') {
            openTasksPanel();
            return true;
          }
          if (cmd === 'goal') {
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
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /model --fast',
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
              .then(async (status) => {
                const toolsByServer: Record<
                  string,
                  Awaited<ReturnType<typeof workspaceActions.loadMcpTools>>
                > = {};
                const resourcesByServer: Record<
                  string,
                  Awaited<ReturnType<typeof workspaceActions.loadMcpResources>>
                > = {};
                await Promise.all(
                  (status?.servers ?? []).map(async (server) => {
                    // Tools and resources load in parallel; a failure in one
                    // must not hide the other, and per-server failures still
                    // let sibling servers render.
                    await Promise.all([
                      (async () => {
                        try {
                          toolsByServer[server.name] =
                            await workspaceActions.loadMcpTools(server.name);
                        } catch {
                          // Allow partial failure — other servers still render
                        }
                      })(),
                      (async () => {
                        // Skip the round-trip for servers that advertise no
                        // resources (or older daemons that omit the count).
                        if (!server.resourceCount) return;
                        try {
                          resourcesByServer[server.name] =
                            await workspaceActions.loadMcpResources(
                              server.name,
                            );
                        } catch {
                          // Allow partial failure — other servers still render
                        }
                      })(),
                    ]);
                  }),
                );
                setMcpDialogMessage({
                  status,
                  toolsByServer,
                  resourcesByServer,
                  showDescriptions: mcpArg === 'desc',
                  showSchema: mcpArg === 'schema',
                  showTips: !mcpArg,
                });
              })
              .catch((error: unknown) => {
                reportError(error, 'Failed to load MCP status');
              });
            return true;
          }
          if (cmd === 'skills') {
            const skillArg = text.slice(match[0].length).trim();
            if (skillArg) {
              if (promptBlocked) {
                return enqueuePrompt(
                  text,
                  images,
                  undefined,
                  commitComposerAccepted,
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /skills command',
              );
            } else {
              if (echoOrDeferLocalCommand(text, images)) return true;
              workspaceActions
                .loadSkillsStatus()
                .then((status) => {
                  const skills = availableSkillInfos(status);
                  setLoadedSkills(skills);
                  if (skills.length === 0) {
                    store.dispatch([
                      { type: 'status', text: t('skills.none') },
                    ]);
                  } else {
                    const list = skills.map((s) => `- ${s.name}`).join('\n');
                    store.dispatch([
                      {
                        type: 'status',
                        text: `${t('skills.available')}\n\n${list}`,
                      },
                    ]);
                  }
                  resumeChatBottomFollow('smooth');
                })
                .catch((error: unknown) => {
                  reportError(error, 'Failed to load skills');
                });
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
              setShowExtensionsDialog(true);
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
                );
              }
              return submitPromptFromEditor(
                text,
                images,
                'Failed to send /rename command',
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
          return enqueuePrompt(text, images, undefined, commitComposerAccepted);
        }
        return submitPromptFromEditor(text, images, 'Failed to send command');
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
          return enqueuePrompt(text, images, undefined, commitComposerAccepted);
        }
        return submitPromptFromEditor(text, images, 'Failed to send message');
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
      createNewSession,
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
    ) => {
      const accepted = handleSubmit(text, images, commitComposerAccepted);
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

  const handleModelSelect = useCallback(
    (modelId: string) => {
      if (!connectionRef.current.sessionId) {
        setPendingModel(modelId);
        return;
      }
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
        });
    },
    [sessionActions, store, reportError, t, setPendingModel],
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
      sendPrompt(`/model --fast ${modelId}`)
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
    ],
  );

  const handleVoiceModelSelect = useCallback(
    (modelId: string) => {
      // Model IDs from the voice picker arrive as bare model IDs (baseModelId),
      // not ACP format. extractVoiceModels() sets id to the baseModelId.
      const bareModelId = extractBareModelId(modelId);
      setWorkspaceSetting('workspace', 'voiceModel', bareModelId).catch(
        (error: unknown) => reportError(error, t('model.setVoice')),
      );
    },
    [reportError, setWorkspaceSetting, t],
  );

  const handleVisionModelSelect = useCallback(
    (modelId: string) => {
      // Model IDs from the picker arrive in ACP format: `modelId(authType)`.
      // Core's resolveVisionModelSelection() expects `authType:modelId`.
      const encoded = encodeVisionModelForSetting(modelId);
      setWorkspaceSetting('workspace', 'visionModel', encoded).catch(
        (error: unknown) => reportError(error, t('model.setVision')),
      );
    },
    [reportError, setWorkspaceSetting, t],
  );

  const modelHandlers: Record<ModelDialogMode, (id: string) => void> = {
    main: handleModelSelect,
    fast: handleFastModelSelect,
    voice: handleVoiceModelSelect,
    vision: handleVisionModelSelect,
  };

  const commands = useMemo(() => {
    return localizeBuiltinDescriptions(
      mergeCommands(connection.commands ?? [], getLocalCommands(t)),
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
  }, [connection.commands, hiddenCommands, t]);

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

  const welcomeHeader = useMemo(
    () =>
      renderWelcomeHeader ? (
        renderWelcomeHeader(welcomeHeaderProps)
      ) : (
        <WelcomeHeader {...welcomeHeaderProps} />
      ),
    [renderWelcomeHeader, welcomeHeaderProps],
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

  return (
    <ThemeProvider value={selectedTheme}>
      <I18nProvider language={selectedLanguage}>
        <div className={appClassName} style={appStyle} data-web-shell-root>
          {!onToast && <ToastHost toasts={toasts} onDismiss={dismissToast} />}
          {showResumeDialog && (
            <DialogShell
              title={t('resume.title')}
              size="lg"
              onClose={() => setShowResumeDialog(false)}
            >
              <ResumeDialog
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
          {showExtensionsDialog && (
            <DialogShell
              title={t('extensions.manage.title')}
              size="lg"
              onClose={() => setShowExtensionsDialog(false)}
            >
              <ExtensionsDialog />
            </DialogShell>
          )}
          {mcpDialogMessage && (
            <DialogShell
              title={t('mcp.manageServers')}
              size="lg"
              onClose={() => setMcpDialogMessage(null)}
            >
              <McpDialog
                message={mcpDialogMessage}
                onClose={() => setMcpDialogMessage(null)}
              />
            </DialogShell>
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
              onClose={() => setShowAuthDialog(false)}
            >
              <AuthMessage
                onMessage={(text, type = 'status') => {
                  store.dispatch([
                    type === 'error'
                      ? { type: 'error', text }
                      : { type: 'status', text },
                  ]);
                }}
                onClose={() => setShowAuthDialog(false)}
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
                  collapsed={sidebarCollapsed && !mobileDrawerOpen}
                  onCollapsedChange={handleSidebarCollapsedChange}
                  onOpenSettings={() => {
                    closeMobileDrawer();
                    openPanel('settings');
                  }}
                  onOpenDaemonStatus={() => {
                    closeMobileDrawer();
                    openPanel('status');
                  }}
                  onOpenScheduledTasks={() => {
                    closeMobileDrawer();
                    openScheduledTasks();
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
                  onNewSession={() => {
                    setMainView('chat');
                    return createNewSession();
                  }}
                  onLoadSession={(sessionId) => {
                    setMainView('chat');
                    return loadSidebarSession(sessionId);
                  }}
                  onError={reportError}
                  mobileOpen={mobileDrawerOpen}
                  sessionListReloadToken={sessionListReloadToken}
                />
              </div>
            )}
            <div
              className={[
                styles.chatPane,
                mainView !== 'chat' ? styles.chatPaneShowingPage : undefined,
                hasMobileComposerBottom
                  ? styles.chatPaneWithMobileComposerBottom
                  : undefined,
                hasWelcomeMiddle ? styles.chatPaneWithWelcomeMiddle : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {sidebarOptions.enabled &&
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
                    onClick={() => setMobileDrawerOpen((open) => !open)}
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
                        : t('sessionsOverview.title')
                  }
                >
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
                  <div className={styles.panelBody} key={activePanel}>
                    {activePanel === 'settings' ? (
                      <SettingsMessage
                        settingsState={workspaceSettingsState}
                        embedded
                        onLanguageChange={handleSettingsLanguageChange}
                        onThemeChange={handleThemeChange}
                        chatWidthMode={chatWidthMode}
                        onChatWidthModeChange={handleChatWidthModeChange}
                        onSubDialog={(key) => {
                          if (key === 'fastModel') setModelDialogMode('fast');
                          else if (key === 'visionModel')
                            setModelDialogMode('vision');
                          else if (key === 'tools.approvalMode')
                            setShowApprovalModeDialog(true);
                        }}
                      />
                    ) : activePanel === 'status' ? (
                      <DaemonStatusDialog />
                    ) : (
                      <SessionOverviewPanel
                        onOpenSession={handleOpenSessionFromOverview}
                        onOpenSplit={openSplitView}
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
                      onCreateViaChat={() => {
                        // Start a FRESH session and jump to it so the task-
                        // creation chat doesn't pile onto the current
                        // conversation, then prime the composer so the user can
                        // describe the task in natural language; the agent
                        // creates it via its cron_create tool. Focus is deferred
                        // so the new session's composer is mounted/visible first.
                        setMainView('chat');
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
                        // Back returns to the Session Overview (the hub the split
                        // is launched from), not the single-session chat.
                        onExit={handleSplitExit}
                        onError={reportError}
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
                        {showMobileWelcomeFooterMiddle ? (
                          <div className={styles.mobileWelcomeGroup}>
                            <div
                              className={[
                                styles.content,
                                showFloatingTodos ||
                                displayMessages.length > 0 ||
                                pendingApproval
                                  ? styles.contentHasMessages
                                  : undefined,
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <MessageList
                                ref={messageListRef}
                                messages={displayMessages}
                                pendingApproval={pendingToolApproval}
                                onShowContextDetail={handleShowContextDetail}
                                loadingTranscript={connection.loadingTranscript}
                                catchingUp={connection.catchingUp}
                                isResponding={streamingState !== 'idle'}
                                activeTurnStartedAt={activeTurnStartedAt}
                                workspaceCwd={connection.workspaceCwd || ''}
                                hideSessionTimeline={
                                  effectiveChatWidthMode === 'wide'
                                }
                                showRetryHint={showRetryHint}
                                onRetryClick={handleRetry}
                                onBranchSession={handleBranchCurrentSession}
                                welcomeHeader={welcomeHeader}
                                centerWelcomeHeader
                                tailContent={undefined}
                                tailKey={undefined}
                                onCanScrollToBottomChange={
                                  handleCanScrollToBottomChange
                                }
                                virtualScrollThreshold={virtualScrollThreshold}
                              />
                            </div>
                            <div className={styles.mobileWelcomeFooterMiddle}>
                              {welcomeFooter}
                            </div>
                          </div>
                        ) : (
                          <div
                            className={[
                              styles.content,
                              showFloatingTodos ||
                              displayMessages.length > 0 ||
                              pendingApproval
                                ? styles.contentHasMessages
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <MessageList
                              ref={messageListRef}
                              messages={displayMessages}
                              pendingApproval={pendingToolApproval}
                              onShowContextDetail={handleShowContextDetail}
                              loadingTranscript={connection.loadingTranscript}
                              catchingUp={connection.catchingUp}
                              isResponding={streamingState !== 'idle'}
                              activeTurnStartedAt={activeTurnStartedAt}
                              workspaceCwd={connection.workspaceCwd || ''}
                              hideSessionTimeline={
                                effectiveChatWidthMode === 'wide'
                              }
                              showRetryHint={showRetryHint}
                              onRetryClick={handleRetry}
                              onBranchSession={handleBranchCurrentSession}
                              welcomeHeader={
                                isChatEmptyState ? welcomeHeader : undefined
                              }
                              tailContent={undefined}
                              tailKey={undefined}
                              onCanScrollToBottomChange={
                                handleCanScrollToBottomChange
                              }
                              virtualScrollThreshold={virtualScrollThreshold}
                            />
                            {btwMessage?.role === 'btw' && (
                              <div className={styles.btwPanel}>
                                <BtwMessage
                                  question={btwMessage.question}
                                  answer={btwMessage.answer}
                                  isPending={btwMessage.isPending}
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </TodoContextsProvider>
                    </CompactModeContext.Provider>

                    <div
                      ref={footerRef}
                      className={
                        CustomFooter
                          ? `${styles.footer} ${styles.footerWithCustomFooter}`
                          : styles.footer
                      }
                    >
                      {canScrollMessageListToBottom && (
                        <div
                          className={
                            showFloatingTodos
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
                      {showFloatingTodos && (
                        <div className={styles.bottomPanels}>
                          <TodoPanel todos={floatingTodos} />
                        </div>
                      )}
                      {/* Only render the outer session's approval on the chat
                          view. Under a full-page view (split / scheduled tasks)
                          it would sit hidden yet still own global keyboard
                          shortcuts — a keypress could confirm an unseen
                          approval. Each split pane surfaces its own approval. */}
                      {pendingToolApproval && mainView === 'chat' && (
                        <div
                          ref={approvalOverlayRef}
                          tabIndex={-1}
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <ToolApproval
                            request={pendingToolApproval}
                            onConfirm={handleConfirm}
                            variant="floating"
                          />
                        </div>
                      )}
                      {pendingAskUserApproval && mainView === 'chat' && (
                        <div
                          ref={approvalOverlayRef}
                          tabIndex={-1}
                          data-testid="approval-overlay"
                          className={styles.approvalOverlay}
                        >
                          <AskUserQuestion
                            request={pendingAskUserApproval}
                            onConfirm={handleConfirm}
                            variant="floating"
                          />
                        </div>
                      )}
                      <div className={styles.composer}>
                        <StreamingStatus startedAt={activeTurnStartedAt} />
                        {escapeHintVisible && streamingState === 'idle' && (
                          <div className={styles.escClearStatus} role="status">
                            {t('editor.escClearHint')}
                          </div>
                        )}
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
                          onCycleMode={handleCycleMode}
                          onToggleShortcuts={handleToggleShortcuts}
                          onCancel={handleCancel}
                          isRunning={streamingState !== 'idle'}
                          isPreparing={isPreparingPrompt}
                          cancelArmed={cancelArmed}
                          disabled={isDisabled}
                          commands={commands}
                          skills={loadedSkills}
                          slashCommandCategoryOrder={slashCommandCategoryOrder}
                          atProviders={atProviders}
                          composerTagIcons={composerTagIcons}
                          queuedMessages={queuedTexts}
                          onFocusFooter={handleFocusTaskPill}
                          onPopQueuedMessages={editLastQueuedPrompt}
                          onClearQueuedMessages={clearQueuedPrompts}
                          currentMode={currentMode}
                          currentModel={currentModel}
                          chatWidthMode={chatWidthMode}
                          showChatWidthToggle={!isChatEmptyState}
                          chatWidthToggleMin={chatWidthToggleMin}
                          visibleToolbarActions={composerToolbarActions}
                          availableModels={availableModels}
                          onSelectMode={handleSetMode}
                          onSelectModel={handleModelSelect}
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
                          placeholderText={t(
                            getComposerPlaceholderKey({
                              catchingUp: Boolean(connection.catchingUp),
                              isPreparingPrompt,
                              isStreaming: streamingState !== 'idle',
                            }),
                          )}
                        />
                      </div>
                      {CustomFooter ? (
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
          </div>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}

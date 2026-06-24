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
  useActions,
  useConnection,
  useDaemonFollowupSuggestion,
  useDaemonMidTurnInjected,
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
import { removeInjectedFromQueue } from './midTurnDedup';
import { MessageList, type MessageListHandle } from './components/MessageList';
import { extractVoiceModels, type VoiceModelOption } from './voice/voiceModels';
import {
  ChatEditor,
  type ComposerToolbarAction,
} from './components/ChatEditor';
import type { EditorHandle } from './hooks/useComposerCore';
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
import { ExtensionsDialog } from './components/dialogs/ExtensionsDialog';
import { SettingsMessage } from './components/messages/SettingsMessage';
import { resolveShellOutputMaxLines } from './components/messages/ToolGroup';
import { isAskUserQuestionToolName } from './components/messages/toolFormatting';
import { ToolApproval } from './components/messages/ToolApproval';
import { AskUserQuestion } from './components/messages/AskUserQuestion';
import { HelpDialog } from './components/dialogs/HelpDialog';
import { ThemeDialog } from './components/dialogs/ThemeDialog';
import { DeleteSessionDialog } from './components/dialogs/DeleteSessionDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { RewindDialog } from './components/dialogs/RewindDialog';
import { getLocalCommands } from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameValue } from './hooks/useAnimationFrameValue';
import { useBackgroundTasks } from './hooks/useBackgroundTasks';
import { useMessages } from './hooks/useMessages';
import { usePanelActive } from './hooks/usePanelActive';
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
import type { SkillInfo } from './completions/slashCompletion';
import { collectSystemInfo } from './utils/systemInfo';
import {
  TasksStatusMessage,
  type SerializedTasksMessage,
} from './components/messages/TasksStatusMessage';
import { isBackgroundSubAgentToolCall } from './adapters/toolClassification';
import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/webui/daemon-react-sdk';
import { serializeContextUsageMessage } from './components/messages/ContextUsageMessage';
import {
  serializeStatsMessage,
  type StatsView,
} from './components/messages/StatsMessage';
import {
  serializeStatusMessage,
  type StatusInfo,
} from './components/messages/StatusMessage';
import {
  MCP_STATUS_ACTIVE_EVENT,
  parseMcpStatusMessage,
  type SerializedMcpStatusMessage,
} from './components/messages/McpStatusMessage';
import { McpDialog } from './components/dialogs/McpDialog';
import {
  GOAL_STATUS_ACTIVE_EVENT,
  parseGoalStatusMessage,
  serializeGoalStatusMessage,
} from './components/messages/GoalStatusMessage';
import { TASKS_STATUS_ACTIVE_EVENT } from './components/messages/TasksStatusMessage';
import { BtwMessage } from './components/messages/BtwMessage';
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
  type WelcomeHeaderRenderer,
  type WelcomeFooterRenderer,
  type ComposerToolbarStartRenderer,
  type ComposerToolbarEndRenderer,
  type FooterRenderer,
  type WebShellTaskInfo,
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
const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 240;
const MAX_TOASTS = 4;
const COMPACT_MODE_SETTING_KEY = 'ui.compactMode';
const HIDE_TIPS_SETTING_KEY = 'ui.hideTips';
const HIDDEN_COMPOSER_MODEL_IDS = new Set(['coder-model(qwen-oauth)']);

function isVisibleComposerModel(model: { id: string }): boolean {
  return !HIDDEN_COMPOSER_MODEL_IDS.has(model.id);
}

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

interface QueuedPrompt {
  id: number;
  text: string;
  images?: PromptImage[];
  onComplete?: () => void;
}

interface ActiveGoalStatus {
  condition: string;
  setAt: number;
}

interface SendPromptOptionsWithRetry {
  optimisticUserMessage?: boolean;
  images?: PromptImage[];
  retry?: boolean;
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

export interface WebShellProps {
  /** Called whenever the attached daemon session id changes. */
  onSessionIdChange?: (sessionId: string) => void;
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
  /** Custom renderer for the tool-card header content after the status icon and tool name. */
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  /** Custom renderer for the welcome header. Receives version, cwd, model, and mode. */
  renderWelcomeHeader?: WelcomeHeaderRenderer;
  /** Custom renderer shown below the chat composer in the empty welcome state. */
  renderWelcomeFooter?: WelcomeFooterRenderer;
  /** Custom renderer inserted before the built-in chat composer toolbar controls. */
  renderComposerToolbarStart?: ComposerToolbarStartRenderer;
  /** Custom renderer inserted after the built-in composer toolbar controls. */
  renderComposerToolbarEnd?: ComposerToolbarEndRenderer;
  /** Custom component for the footer area below the Editor. Replaces the built-in StatusBar. */
  renderFooter?: FooterRenderer;
  /** Collapse thinking blocks to 5 lines with a click-to-expand toggle. */
  compactThinking?: boolean;
  /** Auto-collapse completed turns to just the prompt and final answer, with a per-turn toggle. Defaults to true. */
  collapseCompletedTurns?: boolean;
  /** Enable virtual scrolling only when rendered transcript rows exceed this threshold. Defaults to 200. */
  virtualScrollThreshold?: number;
  /** Custom Markdown behavior for assistant content only. */
  markdown?: WebShellMarkdownCustomization;
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
}

type SessionActionsWithCreate = {
  createSession: () => Promise<{ sessionId: string }>;
};

const emptyComposerApi: WebShellComposerApi = {
  insertText: () => {},
  setText: () => {},
  addTags: () => {},
  removeTag: () => {},
  clear: () => {},
  submit: () => {},
};

type ChatWidthMode = '1000' | 'wide';

const CHAT_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-chat-width';
const DEFAULT_CHAT_MAX_WIDTH = 1000;
const CHAT_SHELL_HORIZONTAL_PADDING = 40;

function readChatWidthMode(): ChatWidthMode {
  if (typeof window === 'undefined') return '1000';
  try {
    return window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY) === 'wide'
      ? 'wide'
      : '1000';
  } catch {
    return '1000';
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

function replaceSessionUrl(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  if (!import.meta.env.DEV) {
    url.searchParams.delete('token');
    url.searchParams.delete('daemon');
  }
  window.history.replaceState(null, '', url);
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

function logSessionNoticesHook(notices: readonly DaemonSessionNotice[]): void {
  if (notices.length > 0) {
    console.info('[web-shell] useSessionNotices()', { notices });
  }
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

function formatModelAuthType(authType: string): string {
  const normalized = authType.trim();
  if (normalized.startsWith('USE_')) {
    return normalized.slice(4).toLowerCase().replace(/_/g, '-');
  }
  return normalized.toLowerCase();
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

function serializeModelSwitchSummary(summary: ModelSwitchSummary): string {
  return (
    `● authType: ${formatModelAuthType(summary.authType)}` +
    `\n  Using ${summary.isRuntime ? 'runtime ' : ''}model: ${summary.modelId}` +
    `\n  Base URL: ${summary.baseUrl}` +
    `\n  API key: ${summary.apiKey}`
  );
}

function parseModelSwitchStatusModel(content: string): string | null {
  const prefix = 'Model switched: ';
  if (!content.startsWith(prefix)) return null;
  const rawModel = content.slice(prefix.length).trim();
  return rawModel.replace(/\([^()]+\)$/, '');
}

function parseModelSwitchSummaryModel(content: string): string | null {
  if (!content.startsWith('● authType:')) return null;
  const match = content.match(/\n {2}Using (?:runtime )?model: ([^\n]+)/);
  return match?.[1]?.trim() || null;
}

function filterDuplicateModelSwitchMessages(
  messages: readonly Message[],
): Message[] {
  const summarizedModels = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'system' || message.variant !== 'info') continue;
    const model = parseModelSwitchSummaryModel(message.content);
    if (model) summarizedModels.add(model);
  }
  if (summarizedModels.size === 0) return [...messages];
  return messages.filter((message) => {
    if (message.role !== 'system' || message.variant !== 'info') return true;
    const statusModel = parseModelSwitchStatusModel(message.content);
    return !statusModel || !summarizedModels.has(statusModel);
  });
}

function hasMcpStatusPanel(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'system' &&
      message.variant === 'info' &&
      parseMcpStatusMessage(message.content) !== null,
  );
}

function isDaemonApprovalMode(mode: string): mode is DaemonApprovalMode {
  return DAEMON_APPROVAL_MODES.includes(mode as DaemonApprovalMode);
}

function isEditToolPermission(request: PermissionRequest): boolean {
  return request.toolKind === 'edit';
}

function isAskUserPermission(request: PermissionRequest | null): boolean {
  if (
    !request?.rawInput?.questions ||
    !Array.isArray(request.rawInput.questions)
  ) {
    return false;
  }
  if (!request.toolName) return true;
  return isAskUserQuestionToolName(request.toolName);
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

function QueuedPromptDisplay({
  prompts,
  t,
  onDelete,
  onInsert,
  onEditLast,
}: {
  prompts: readonly QueuedPrompt[];
  t: ReturnType<typeof getTranslator>;
  onDelete: (id: number) => void;
  onInsert: (id: number) => void;
  onEditLast: () => void;
}) {
  if (prompts.length === 0) return null;
  const lastPromptId = prompts[prompts.length - 1]?.id;

  return (
    <div className={styles.queuedPrompts}>
      {prompts.map((prompt) => {
        const normalizedPreview = prompt.text.replace(/\s+/g, ' ').trim();
        const preview =
          normalizedPreview.length > MAX_QUEUED_PROMPT_PREVIEW_CHARS
            ? `${normalizedPreview.slice(0, MAX_QUEUED_PROMPT_PREVIEW_CHARS)}...`
            : normalizedPreview;
        const imageCount = prompt.images?.length ?? 0;
        return (
          <div key={prompt.id} className={styles.queuedPrompt}>
            <span className={styles.queuedPromptText}>
              {preview}
              {imageCount > 0
                ? ` ${t('queue.imageCount', { count: imageCount })}`
                : ''}
            </span>
            <span className={styles.queuedPromptActions}>
              <button
                type="button"
                className={styles.queuedPromptAction}
                onClick={() => onDelete(prompt.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3.5 4.5h9M6.5 2.5h3M5 4.5l.5 8h5l.5-8"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {t('queue.delete')}
              </button>
              {imageCount === 0 && (
                <button
                  type="button"
                  className={styles.queuedPromptAction}
                  onClick={() => onInsert(prompt.id)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 3.5v7M4.5 7 8 10.5 11.5 7M3.5 12.5h9"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t('queue.insert')}
                </button>
              )}
              {prompt.id === lastPromptId && (
                <button
                  type="button"
                  className={styles.queuedPromptAction}
                  onClick={onEditLast}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M3.5 11.5 4 9l6.7-6.7a1.1 1.1 0 0 1 1.6 0l1.4 1.4a1.1 1.1 0 0 1 0 1.6L7 12l-2.5.5h-1z"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t('queue.edit')}
                </button>
              )}
            </span>
          </div>
        );
      })}
      <div className={styles.queuedHint}>{t('queue.footer')}</div>
    </div>
  );
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
  renderToolHeaderExtra,
  renderWelcomeHeader,
  renderWelcomeFooter,
  renderComposerToolbarStart,
  renderComposerToolbarEnd,
  renderFooter,
  chatMaxWidth,
  composerToolbarActions,
  compactThinking = false,
  collapseCompletedTurns = true,
  virtualScrollThreshold,
  markdown,
  onTranscriptChange,
  onToast,
  composerRef,
  onComposerReady,
  composerInput,
  composerInputVersion,
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
  const customization = useMemo(
    () => ({
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdown,
    }),
    [
      renderToolHeaderExtra,
      renderWelcomeHeader,
      renderWelcomeFooter,
      renderComposerToolbarStart,
      renderComposerToolbarEnd,
      renderFooter,
      compactThinking,
      collapseCompletedTurns,
      markdown,
    ],
  );
  const CustomFooter = renderFooter;
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
  // Scopes explicit "insert queued message" POST(s) to the current turn.
  // Aborted when the turn settles so a slow/late insert can't arrive during a
  // subsequent turn and get injected in the wrong place.
  const midTurnEnqueueAbortRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef(connection.sessionId);
  const displayMessages = useMemo(() => {
    const localMessages = [recapMessage].filter(
      (message): message is LocalAnchoredMessage => message !== null,
    );
    if (localMessages.length === 0) {
      return filterDuplicateModelSwitchMessages(messages);
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
    return filterDuplicateModelSwitchMessages(result);
  }, [messages, recapMessage]);
  const hasMcpPanelMessage = useMemo(
    () => hasMcpStatusPanel(displayMessages),
    [displayMessages],
  );
  useEffect(() => {
    if (hasMcpPanelMessage) return;
    window.dispatchEvent(
      new CustomEvent(MCP_STATUS_ACTIVE_EVENT, {
        detail: { active: false },
      }),
    );
  }, [hasMcpPanelMessage]);
  const messageBlocks = useAnimationFrameValue(blocks);
  const rawPendingApproval = useMemo(
    () => extractPendingPermission(messageBlocks),
    [messageBlocks],
  );
  const pendingApproval = useShallowMemo(rawPendingApproval);
  const pendingAskUserApproval = isAskUserPermission(pendingApproval)
    ? pendingApproval
    : null;
  const pendingToolApproval =
    pendingApproval && !pendingAskUserApproval ? pendingApproval : null;
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = pendingApproval;
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
  // The all-completed list is only shown as a transient "all done" moment
  // when the panel was already visible live in this client; on session
  // restore (catch-up replay) a historical finished list stays hidden.
  // State is adjusted during render (not in an effect) so the
  // active → completed transition doesn't unmount the panel for a frame.
  const [todoPanelMode, setTodoPanelMode] = useState<
    'hidden' | 'active' | 'completed'
  >('hidden');
  const nextTodoPanelMode =
    connection.catchingUp || floatingTodos.length === 0
      ? 'hidden'
      : !floatingTodosAllCompleted
        ? 'active'
        : todoPanelMode === 'hidden'
          ? 'hidden'
          : 'completed';
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
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const previousFooterRectRef = useRef<DOMRect | null>(null);
  const previousEmptyStateRef = useRef(false);
  const resumeChatBottomFollow = useCallback(
    (behavior: ScrollBehavior = 'smooth') => {
      setShowScrollToBottom(false);
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
  const sendPrompt = useCallback(
    (
      text: string,
      images?: PromptImage[],
      opts?: { optimisticUserMessage?: boolean; retry?: boolean },
    ) => {
      clearFollowup();
      const isUserPrompt = !text.trimStart().startsWith('/');
      if (!opts?.retry && isUserPrompt) {
        lastSubmittedPromptRef.current = text;
        lastSubmittedImagesRef.current = images;
        retriedTurnErrorIdRef.current = null;
      }
      setShowRetryHint(false);
      const promptOptions: SendPromptOptionsWithRetry = {
        images,
        optimisticUserMessage: opts?.optimisticUserMessage,
        retry: opts?.retry,
      };
      return (
        sessionActions.sendPrompt as (
          promptText: string,
          options?: SendPromptOptionsWithRetry,
        ) => ReturnType<typeof sessionActions.sendPrompt>
      )(text, promptOptions);
    },
    [clearFollowup, sessionActions],
  );
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
        setLoadedSkills(
          (status?.skills ?? [])
            .map((s) => ({ name: s.name, description: s.description ?? '' }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
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
  const [showExtensionsDialog, setShowExtensionsDialog] = useState(false);
  const [mcpDialogMessage, setMcpDialogMessage] =
    useState<SerializedMcpStatusMessage | null>(null);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
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
  const escPressCountRef = useRef(0);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tasksDialogMessage, setTasksDialogMessage] =
    useState<SerializedTasksMessage | null>(null);
  const mcpPanelActive = usePanelActive(MCP_STATUS_ACTIVE_EVENT);
  const tasksPanelActive = usePanelActive(TASKS_STATUS_ACTIVE_EVENT);
  const [selectedTheme, setSelectedTheme] = useState<WebShellTheme>(
    providedTheme ?? WebShellThemeId.Dark,
  );
  const [currentModel, setCurrentModel] = useState('');
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const sessionDisplayName = connection.displayName;
  const [currentMode, setCurrentMode] = useState('default');
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedTexts = useMemo(
    () => queuedPrompts.map((prompt) => prompt.text),
    [queuedPrompts],
  );
  const availableModels = useMemo(
    () =>
      (connection.models ?? []).filter(isVisibleComposerModel).map((m) => ({
        id: m.id,
        label: m.label,
      })),
    [connection.models],
  );
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const nextQueuedPromptIdRef = useRef(1);
  const drainingQueueRef = useRef(false);
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
    showSettingsDialog ||
    showMemoryDialog ||
    showAuthDialog;
  const bottomHidden = mcpPanelActive || tasksPanelActive;
  const interactionBlocked = dialogOpen || bottomHidden;

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      if (isAbortError(error)) return;
      if (isDaemonTurnError(error)) {
        console.debug('[web-shell] turn error rendered in transcript', error);
        return;
      }
      if (isAlreadyDispatched(error)) {
        console.debug('[web-shell] error already handled by notice', error);
        return;
      }
      const message = formatError(error, fallback);
      console.error('[web-shell]', message, error);
      pushToast('error', message);
    },
    [pushToast],
  );

  useEffect(() => {
    logSessionNoticesHook(notices);
    for (const notice of notices) {
      if (shouldToastNotice(notice)) {
        pushToast(toastToneFromNotice(notice), notice.message);
      } else if (notice.category === 'lifecycle') {
        console.debug('[web-shell] daemon notice', notice);
      } else {
        console.warn('[web-shell] daemon notice', notice);
      }
      dismissNotice(notice.id);
    }
  }, [dismissNotice, notices, pushToast]);

  const onBugReportRef = useRef(onBugReport);
  onBugReportRef.current = onBugReport;

  useEffect(() => {
    activeSessionIdRef.current = connection.sessionId;
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setRecapMessage(null);
    setBtwMessage(null);
    setTasksDialogMessage(null);
    lastRecapBlockCountRef.current = 0;
  }, [connection.sessionId]);

  const runVisibleRecap = useCallback(() => {
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
        content: `※ recap: ${t('recap.loading')}`,
        variant: 'info',
      },
    });
    sessionActions.recapSession().then(
      (result) => {
        if (activeSessionIdRef.current !== sessionId) return;
        setRecapMessage({
          anchorAfterId,
          anchorIndex,
          message: {
            id: messageId,
            role: 'system',
            content: result.recap
              ? `※ recap: ${result.recap}`
              : t('recap.empty'),
            variant: 'info',
          },
        });
      },
      (error: unknown) => {
        if (activeSessionIdRef.current !== sessionId) return;
        setRecapMessage(null);
        if (!isAbortError(error) && !isAlreadyDispatched(error)) {
          console.warn('[web-shell] unhandled recap failure', error);
        }
      },
    );
  }, [connection.sessionId, messages, sessionActions, t]);

  const runVisibleBtw = useCallback(
    (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question) {
        pushToast('error', t('btw.empty'));
        return;
      }

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
            if (activeSessionIdRef.current !== sessionId) return;
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
            if (activeSessionIdRef.current !== sessionId) return;
            if (btwAbortControllerRef.current !== abortController) return;
            btwAbortControllerRef.current = null;
            setBtwMessage(null);
            if (!isAbortError(error) && !isAlreadyDispatched(error)) {
              console.warn('[web-shell] unhandled btw failure', error);
            }
          },
        );
    },
    [connection.sessionId, pushToast, sessionActions, t],
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

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  const enqueuePrompt = useCallback(
    (text: string, images?: PromptImage[], onComplete?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return true;
      const nextPrompt: QueuedPrompt = {
        id: nextQueuedPromptIdRef.current++,
        text: trimmed,
        images: images ? [...images] : undefined,
        onComplete,
      };
      queuedPromptsRef.current = [...queuedPromptsRef.current, nextPrompt];
      setQueuedPrompts(queuedPromptsRef.current);
      return true;
    },
    [],
  );

  // When the turn settles, abort any still-in-flight explicit insert so it can't
  // arrive during the next turn (see midTurnEnqueueAbortRef). If aborted, the
  // message remains in queuedPrompts.
  useEffect(() => {
    if (streamingState !== 'idle') return;
    const ctrl = midTurnEnqueueAbortRef.current;
    if (!ctrl) return;
    // A controller exists ⇒ at least one mid-turn push was issued this turn.
    // Cancel it so a still-in-flight push can't land in the next turn (a
    // completed one makes this a no-op). Debug-only, mirrors the server-side
    // mid-turn observability.
    console.debug('[mid-turn] turn settled; cancelling any in-flight push');
    ctrl.abort();
    midTurnEnqueueAbortRef.current = null;
  }, [streamingState]);

  const popNextQueuedPrompt = useCallback((): QueuedPrompt | null => {
    const [nextPrompt, ...rest] = queuedPromptsRef.current;
    if (!nextPrompt) return null;
    queuedPromptsRef.current = rest;
    setQueuedPrompts(rest);
    return nextPrompt;
  }, []);

  const popQueuedPromptsForEdit = useCallback((): string | null => {
    const current = queuedPromptsRef.current;
    if (current.length === 0) return null;
    const next = current.slice(0, -1);
    const prompt = current[current.length - 1];
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
    return prompt?.text ?? null;
  }, []);

  const removeQueuedPrompt = useCallback((id: number) => {
    const next = queuedPromptsRef.current.filter((prompt) => prompt.id !== id);
    if (next.length === queuedPromptsRef.current.length) return;
    queuedPromptsRef.current = next;
    setQueuedPrompts(next);
  }, []);

  const insertQueuedPrompt = useCallback(
    async (id: number) => {
      const prompt = queuedPromptsRef.current.find((item) => item.id === id);
      if (!prompt || (prompt.images?.length ?? 0) > 0) return;
      let abort = midTurnEnqueueAbortRef.current;
      if (!abort) {
        abort = new AbortController();
        midTurnEnqueueAbortRef.current = abort;
      }
      let result: Awaited<
        ReturnType<typeof sessionActions.enqueueMidTurnMessage>
      >;
      try {
        result = await sessionActions.enqueueMidTurnMessage(prompt.text, {
          signal: abort.signal,
        });
      } catch (error) {
        reportError(error, t('queue.insertFailed'));
        return;
      }
      if (!result.accepted) return;
      const next = queuedPromptsRef.current.filter((item) => item.id !== id);
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    },
    [reportError, sessionActions, t],
  );

  const editLastQueuedPrompt = useCallback(() => {
    const queuedText = popQueuedPromptsForEdit();
    if (!queuedText) return;
    const current = editorRef.current?.getText() ?? '';
    const next = current.trim() ? `${queuedText}\n${current}` : queuedText;
    editorRef.current?.setText(next);
    editorRef.current?.focus();
  }, [popQueuedPromptsForEdit]);

  const clearQueuedPrompts = useCallback((): boolean => {
    if (queuedPromptsRef.current.length === 0) return false;
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    store.dispatch([{ type: 'status', text: t('queue.cleared') }]);
    return true;
  }, [store, t]);

  // When the daemon drains queued messages into the running turn it emits
  // `mid_turn_message_injected` (one frame per tool batch). Drop the matching
  // (text-only) entries from the local queue so the idle-time drain doesn't ALSO
  // resend them as the next turn. Reconcile EVERY accumulated batch, not just the
  // newest — a multi-batch turn can publish several frames back-to-back, and the
  // first must not be lost before this runs. The frames arrive in-order ahead of
  // the turn-complete frame that flips streamingState to idle, so this runs
  // before that resend fires; `consume()` then clears the reconciled batches.
  const { batches: midTurnInjectedBatches, consume: consumeMidTurnInjected } =
    useDaemonMidTurnInjected();
  useEffect(() => {
    const sessionId = connection.sessionId;
    if (!sessionId || midTurnInjectedBatches.length === 0) return;
    // Pass OUR client id so only batches the daemon stamped with it (or
    // anonymous ones) are deduped. The daemon stamps every drained frame with
    // the originator's client id, and the web-shell always sends one, so
    // omitting this would skip every batch — leaving our own messages in the
    // queue to be resent next turn (double delivery). A peer on the same
    // session keeps its own coincidentally-equal entry.
    if (
      connection.clientId === undefined &&
      midTurnInjectedBatches.some(
        (b) => b.sessionId === sessionId && b.originatorClientId !== undefined,
      )
    ) {
      // Edge: stamped batches but no client id yet (older daemon / reconnect
      // timing). Dedupe skips them, so they may be resent next turn — make it
      // diagnosable rather than a silent double-delivery.
      console.debug(
        '[mid-turn] originator-stamped batches but no client id; dedupe skipped (may resend next turn)',
      );
    }
    const next = removeInjectedFromQueue(
      queuedPromptsRef.current,
      midTurnInjectedBatches,
      sessionId,
      connection.clientId,
    );
    if (next) {
      queuedPromptsRef.current = next;
      setQueuedPrompts(next);
    }
    // Consume ONLY this session's batches. The reconcile above is session-
    // scoped, so a batch for another session (a late frame after an in-place
    // session switch) must NOT be cleared here — it was never reconciled and
    // would otherwise be lost on switch-back (resent next turn = double
    // delivery). Identity-removal also leaves any frame that arrived after this
    // render's snapshot for the next effect run.
    consumeMidTurnInjected(
      midTurnInjectedBatches.filter((b) => b.sessionId === sessionId),
    );
  }, [
    midTurnInjectedBatches,
    connection.sessionId,
    connection.clientId,
    consumeMidTurnInjected,
  ]);

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
  const shellOutputMaxLines = resolveShellOutputMaxLines(workspaceSettings);
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
        enqueuePrompt(command, undefined, refreshSettings);
        return;
      }
      sendPrompt(command)
        .then(refreshSettings)
        .catch((error: unknown) => {
          handleLanguageChange(previousLanguage);
          reportError(error, 'Failed to sync /language command');
        });
    },
    [
      enqueuePrompt,
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
    [sessionActions, reportError, store, t],
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
    if (connection.sessionId) {
      setActiveGoal(null);
      onSessionIdChange?.(connection.sessionId);
      if (!onSessionIdChange) {
        replaceSessionUrl(connection.sessionId);
      }
    }
  }, [connection.sessionId, onSessionIdChange]);

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
              { type: 'status', text: `※ recap: ${result.recap}` },
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
  }, [connection.sessionId, sessionActions, store]);

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
      store.appendLocalUserMessage(commandText);
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
    [store, sessionActions, reportError, resumeChatBottomFollow],
  );

  // Stable reference: this travels through the memoized MessageList →
  // MessageItem chain, so an inline closure would defeat their memo.
  const handleShowContextDetail = useCallback(() => {
    showContextUsage('/context detail', true);
  }, [showContextUsage]);

  const branchCurrentSession = useCallback(
    (name?: string) => {
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
    [reportError, sessionActions, store, t],
  );
  const handleBranchCurrentSession = useCallback(() => {
    branchCurrentSession();
  }, [branchCurrentSession]);

  const createNewSession = useCallback(() => {
    (sessionActions as typeof sessionActions & SessionActionsWithCreate)
      .createSession()
      .then((session) => {
        if (onSessionIdChange) {
          onSessionIdChange(session.sessionId);
          return;
        }
        return sessionActions.loadSession(session.sessionId);
      })
      .catch((error: unknown) => {
        reportError(error, 'Failed to create a new session');
      });
  }, [onSessionIdChange, reportError, sessionActions]);

  const openTasksPanel = useCallback(() => {
    sessionActions
      .getTasks()
      .then((snapshot) => {
        setTasksDialogMessage({ snapshot });
      })
      .catch((error: unknown) => {
        reportError(error, 'Failed to load tasks');
      });
  }, [reportError, sessionActions]);

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
      store.appendLocalUserMessage(text);
      sessionActions.clearGoal().catch((error: unknown) => {
        reportError(error, 'Failed to clear /goal');
      });
      return true;
    },
    [reportError, sessionActions, store],
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
      opts?: { sendToDaemon?: boolean },
    ) => {
      const goalArg = text.replace(/^\/goal\b/i, '').trim();
      const lowerGoalArg = goalArg.toLowerCase();
      const sendToDaemon = opts?.sendToDaemon ?? true;

      if (goalArg && GOAL_CLEAR_KEYWORDS.has(lowerGoalArg)) {
        if (!sendToDaemon) {
          store.appendLocalUserMessage(text);
          dispatchGoalCleared(activeGoalRef.current);
          return true;
        }
        return handleBusyGoalClear(text);
      } else if (goalArg) {
        store.appendLocalUserMessage(text);
        if (!sendToDaemon) {
          dispatchGoalSet(goalArg, Date.now());
          return true;
        }
        sendPrompt(text, images, { optimisticUserMessage: false }).catch(
          (error: unknown) => {
            reportError(error, 'Failed to send /goal command');
          },
        );
        return true;
      }

      store.appendLocalUserMessage(text);
      if (sendToDaemon) {
        sendPrompt(text, images, { optimisticUserMessage: false }).catch(
          (error: unknown) =>
            reportError(error, 'Failed to send /goal command'),
        );
      }
      return true;
    },
    [
      dispatchGoalCleared,
      dispatchGoalSet,
      handleBusyGoalClear,
      reportError,
      sendPrompt,
      store,
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
    (text: string, images?: PromptImage[]) => {
      const promptBlocked = streamingStateRef.current !== 'idle';
      if (text.startsWith('/')) {
        const match = text.match(/^\/([\w-]+)/);
        if (match) {
          const cmd = match[1];
          if (hiddenCommands.has(normalizeHiddenCommand(cmd))) {
            if (promptBlocked) return enqueuePrompt(text, images);
            sendPrompt(text, images).catch((error: unknown) =>
              reportError(error, 'Failed to send hidden slash command'),
            );
            return true;
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
              return enqueuePrompt(text, images);
            }
            return handleGoalSlashCommand(text, images);
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
                sendPrompt(`/language ui ${nextLanguage}`)
                  .then(() => sessionActions.refreshCommands())
                  .catch((error: unknown) => {
                    reportError(error, 'Failed to sync /language command');
                  });
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
            setShowRewindDialog(true);
            return true;
          }
          if (cmd === 'branch') {
            if (promptBlocked) return enqueuePrompt(text, images);
            const branchName = text.slice(match[0].length).trim();
            branchCurrentSession(branchName || undefined);
            return true;
          }
          if (cmd === 'fork') {
            if (promptBlocked) return enqueuePrompt(text, images);
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
              if (promptBlocked) return enqueuePrompt(text, images);
              sendPrompt(text, images).catch((error: unknown) =>
                reportError(error, 'Failed to send /model --fast'),
              );
              return true;
            }
            if (modelArg === '--voice') {
              store.appendLocalUserMessage(text);
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
              if (promptBlocked) return enqueuePrompt(text, images);
              sendPrompt(text, images).catch((error: unknown) =>
                reportError(error, 'Failed to send /model --voice'),
              );
              return true;
            }
            if (modelArg) {
              sessionActions
                .setModel(modelArg)
                .then(() => {
                  setCurrentModel(modelArg);
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
            if (promptBlocked) return enqueuePrompt(text, images);
            const prompt = text.slice(match[0].length).trim();
            sessionActions
              .setApprovalMode('plan')
              .then(() => {
                setCurrentMode('plan');
                if (prompt) {
                  sendPrompt(prompt, images).catch((error: unknown) =>
                    reportError(error, 'Failed to send plan prompt'),
                  );
                }
              })
              .catch((error: unknown) => {
                reportError(error, t('mode.plan'));
              });
            return true;
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
                await Promise.all(
                  (status?.servers ?? []).map(async (server) => {
                    try {
                      toolsByServer[server.name] =
                        await workspaceActions.loadMcpTools(server.name);
                    } catch {
                      // Allow partial failure — other servers still render
                    }
                  }),
                );
                setMcpDialogMessage({
                  status,
                  toolsByServer,
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
              if (promptBlocked) return enqueuePrompt(text, images);
              sendPrompt(text, images).catch((error: unknown) =>
                reportError(error, 'Failed to send /skills command'),
              );
            } else {
              store.appendLocalUserMessage(text);
              workspaceActions
                .loadSkillsStatus()
                .then((status) => {
                  const skills = (status?.skills ?? [])
                    .map((s) => ({
                      name: s.name,
                      description: s.description ?? '',
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name));
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
              store.appendLocalUserMessage(text);
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
            setShowSettingsDialog(true);
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
              if (promptBlocked) {
                store.appendLocalUserMessage(text);
                store.dispatch([
                  {
                    type: 'error',
                    text: t('extensions.install.waitForTurn'),
                  },
                ]);
                return true;
              }
              const clientId = connectionRef.current.clientId;
              if (!clientId) {
                store.appendLocalUserMessage(text);
                store.dispatch([
                  {
                    type: 'error',
                    text: t('extensions.install.waitForSession'),
                  },
                ]);
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
            store.appendLocalUserMessage(text);
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
              if (promptBlocked) return enqueuePrompt(text, images);
              sendPrompt(text, images).catch((error: unknown) =>
                reportError(error, 'Failed to send /rename command'),
              );
              return true;
            }
            const displayName = renameArg.displayName;
            if (!displayName) {
              pushToast('error', t('rename.empty'));
              return true;
            }
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
              sessionActions.loadSession(sessionId).catch((error: unknown) => {
                reportError(error, 'Failed to load session');
              });
            } else {
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
            store.appendLocalUserMessage(text);
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
            store.appendLocalUserMessage(text);
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
            store.appendLocalUserMessage(text);
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
        if (promptBlocked) return enqueuePrompt(text, images);
        sendPrompt(text, images).catch((error: unknown) =>
          reportError(error, 'Failed to send command'),
        );
        return true;
      } else if (text.startsWith('!')) {
        if (promptBlocked) return enqueuePrompt(text, images);
        const cmd = text.slice(1).trim();
        if (!cmd) return false;
        sessionActions.sendShellCommand(cmd).catch((error: unknown) => {
          reportError(error, 'Failed to execute shell command');
        });
        return true;
      } else {
        if (promptBlocked) return enqueuePrompt(text, images);
        sendPrompt(text, images).catch((error: unknown) =>
          reportError(error, 'Failed to send message'),
        );
        return true;
      }
    },
    [
      sendPrompt,
      sessionActions,
      store,
      enqueuePrompt,
      branchCurrentSession,
      createNewSession,
      handleBusyGoalClear,
      handleGoalSlashCommand,
      handleThemeChange,
      handleSetMode,
      handleLanguageChange,
      openTasksPanel,
      hiddenCommands,
      pushToast,
      reportError,
      runVisibleRecap,
      runVisibleBtw,
      resumeChatBottomFollow,
      selectedLanguage,
      showContextUsage,
      t,
      workspaceActions,
    ],
  );

  const handleEditorSubmit = useCallback(
    (text: string, images?: PromptImage[]) => {
      const accepted = handleSubmit(text, images);
      if (accepted !== false) {
        resumeChatBottomFollow('smooth');
      }
      return accepted;
    },
    [handleSubmit, resumeChatBottomFollow],
  );

  useEffect(() => {
    if (drainingQueueRef.current) return;
    if (!connected) return;
    if (streamingState !== 'idle') return;
    if (interactionBlocked) return;
    if (pendingApproval) return;
    if (queuedPrompts.length === 0) return;

    const nextPrompt = popNextQueuedPrompt();
    if (!nextPrompt) return;

    drainingQueueRef.current = true;
    let sent = false;
    const timer = window.setTimeout(() => {
      sent = true;
      try {
        handleSubmit(nextPrompt.text, nextPrompt.images);
        nextPrompt.onComplete?.();
      } finally {
        drainingQueueRef.current = false;
      }
    }, 0);
    return () => {
      if (!sent) {
        // Cleanup ran before timeout fired — put the prompt back at the
        // front of the queue so it's not lost. This can happen when any
        // dependency (e.g. handleSubmit, streamingState) changes between
        // popNextQueuedPrompt() and the setTimeout firing.
        queuedPromptsRef.current = [nextPrompt, ...queuedPromptsRef.current];
        setQueuedPrompts(queuedPromptsRef.current);
      }
      window.clearTimeout(timer);
      drainingQueueRef.current = false;
    };
  }, [
    connected,
    interactionBlocked,
    handleSubmit,
    pendingApproval,
    popNextQueuedPrompt,
    queuedPrompts,
    streamingState,
  ]);

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
  const handleFollowStateChange = useCallback((isFollowing: boolean) => {
    setShowScrollToBottom(!isFollowing);
  }, []);

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

  useEffect(() => {
    const resetEscapeState = () => {
      escPressCountRef.current = 0;
      setEscapeHintVisible(false);
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;

      if (e.key !== 'Escape') {
        if (escPressCountRef.current > 0) {
          resetEscapeState();
        }
        if (e.key === 'Tab' && e.shiftKey && !interactionBlocked) {
          e.preventDefault();
          handleCycleMode();
        }
        return;
      }

      if (pendingApproval || interactionBlocked) return;

      if (clearQueuedPrompts()) {
        e.preventDefault();
        resetEscapeState();
        return;
      }

      if (editorRef.current?.hasInput()) {
        e.preventDefault();
        if (escPressCountRef.current === 0) {
          escPressCountRef.current = 1;
          setEscapeHintVisible(true);
          if (escapeTimerRef.current) {
            clearTimeout(escapeTimerRef.current);
          }
          escapeTimerRef.current = setTimeout(() => {
            resetEscapeState();
          }, 500);
        } else {
          editorRef.current?.clear();
          resetEscapeState();
        }
        return;
      }

      if (streamingState !== 'idle') {
        e.preventDefault();
        handleCancel();
        resetEscapeState();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      escPressCountRef.current = 0;
      setEscapeHintVisible(false);
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = null;
      }
    };
  }, [
    streamingState,
    handleCancel,
    handleCycleMode,
    pendingApproval,
    interactionBlocked,
    clearQueuedPrompts,
  ]);

  const isDisabled = !connected || connection.catchingUp;

  const handleModelSelect = useCallback(
    (modelId: string) => {
      sessionActions
        .setModel(modelId)
        .then((result) => {
          const summary = getModelSwitchSummary(result);
          setCurrentModel(summary?.modelId ?? modelId);
          if (summary) {
            store.dispatch({
              type: 'debug',
              text: serializeModelSwitchSummary(summary),
            });
          }
        })
        .catch((error: unknown) => {
          reportError(error, t('model.switch'));
        });
    },
    [sessionActions, store, reportError, t],
  );

  const handleFastModelSelect = useCallback(
    (modelId: string) => {
      if (streamingState !== 'idle') {
        enqueuePrompt(`/model --fast ${modelId}`);
        return;
      }
      sendPrompt(`/model --fast ${modelId}`).catch((error: unknown) => {
        reportError(error, 'Failed to switch fast model');
      });
    },
    [enqueuePrompt, sendPrompt, streamingState, reportError],
  );

  // Persist via the prompt channel (like `/model --fast`): the daemon's command
  // processor writes `voiceModel` to settings. The `/workspace/settings` route
  // is token-gated, but browser voice runs on loopback-no-token — so this is
  // the path that actually works there. The daemon's /voice/stream reads it back.
  const handleVoiceModelSelect = useCallback(
    (modelId: string) => {
      if (streamingState !== 'idle') {
        enqueuePrompt(`/model --voice ${modelId}`);
        return;
      }
      sendPrompt(`/model --voice ${modelId}`).catch((error: unknown) => {
        reportError(error, t('model.setVoice'));
      });
    },
    [enqueuePrompt, sendPrompt, streamingState, reportError, t],
  );

  const commands = useMemo(() => {
    const skillNames = new Set(connection.skills ?? []);
    return mergeCommands(connection.commands ?? [], getLocalCommands(t))
      .filter(
        (command) => !hiddenCommands.has(normalizeHiddenCommand(command.name)),
      )
      .map((command) => {
        if (!skillNames.has(command.name)) return command;
        return {
          ...command,
          displayCategory: 'skill' as const,
          description: command.description || t('skills.run'),
        };
      });
  }, [connection.commands, connection.skills, hiddenCommands, t]);

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
    displayMessages.length === 0 &&
    !showFloatingTodos &&
    !pendingApproval &&
    !btwMessage;
  const chatWidthToggleMin = getChatMaxWidth(chatMaxWidth);

  const appClassName = [
    styles.app,
    styles.appChat,
    isChatEmptyState ? styles.appChatEmpty : undefined,
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
      ...getChatWidthStyle(chatWidthMode, chatMaxWidth),
    }),
    [chatMaxWidth, chatWidthMode, externalStyle],
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
              title={
                modelDialogMode === 'fast'
                  ? t('model.setFast')
                  : modelDialogMode === 'voice'
                    ? t('model.setVoice')
                    : t('model.select')
              }
              size="lg"
              onClose={() => setModelDialogMode(null)}
            >
              <ModelDialog
                mode={modelDialogMode}
                models={modelDialogMode === 'voice' ? voiceModels : undefined}
                currentModelId={
                  modelDialogMode === 'voice' ? currentVoiceModel : undefined
                }
                onSelect={(modelId) => {
                  if (modelDialogMode === 'fast') {
                    handleFastModelSelect(modelId);
                  } else if (modelDialogMode === 'voice') {
                    handleVoiceModelSelect(modelId);
                  } else {
                    handleModelSelect(modelId);
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
          {showSettingsDialog && (
            <DialogShell
              title={t('settings.title')}
              size="lg"
              onClose={() => setShowSettingsDialog(false)}
            >
              <SettingsMessage
                settingsState={workspaceSettingsState}
                embedded
                onLanguageChange={handleSettingsLanguageChange}
                onThemeChange={handleThemeChange}
                chatWidthMode={chatWidthMode}
                onChatWidthModeChange={handleChatWidthModeChange}
                onSubDialog={(key) => {
                  setShowSettingsDialog(false);
                  if (key === 'fastModel') setModelDialogMode('fast');
                  else if (key === 'tools.approvalMode')
                    setShowApprovalModeDialog(true);
                }}
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

          <WebShellCustomizationProvider value={customization}>
            <CompactModeContext.Provider value={compactMode}>
              <TodoContextsProvider
                timeline={todoTimeline}
                details={todoDetails}
              >
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
                    onConfirm={handleConfirm}
                    onShowContextDetail={handleShowContextDetail}
                    catchingUp={connection.catchingUp}
                    isResponding={streamingState !== 'idle'}
                    activeTurnStartedAt={activeTurnStartedAt}
                    workspaceCwd={connection.workspaceCwd || ''}
                    shellOutputMaxLines={shellOutputMaxLines}
                    showRetryHint={showRetryHint}
                    onRetryClick={handleRetry}
                    onBranchSession={handleBranchCurrentSession}
                    welcomeHeader={isChatEmptyState ? welcomeHeader : undefined}
                    tailContent={undefined}
                    tailKey={undefined}
                    onFollowStateChange={handleFollowStateChange}
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
              </TodoContextsProvider>
            </CompactModeContext.Provider>

            <div
              ref={footerRef}
              className={
                bottomHidden
                  ? `${styles.footer} ${styles.footerHidden}`
                  : styles.footer
              }
            >
              {showScrollToBottom && (
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
              {pendingToolApproval && (
                <div className={styles.approvalOverlay}>
                  <ToolApproval
                    request={pendingToolApproval}
                    onConfirm={handleConfirm}
                    variant="floating"
                  />
                </div>
              )}
              {pendingAskUserApproval && (
                <div className={styles.approvalOverlay}>
                  <AskUserQuestion
                    request={pendingAskUserApproval}
                    onConfirm={handleConfirm}
                    variant="floating"
                  />
                </div>
              )}
              <div className={styles.composer}>
                <StreamingStatus startedAt={activeTurnStartedAt} />
                <QueuedPromptDisplay
                  prompts={queuedPrompts}
                  t={t}
                  onDelete={removeQueuedPrompt}
                  onInsert={insertQueuedPrompt}
                  onEditLast={editLastQueuedPrompt}
                />
                <ChatEditor
                  ref={setEditorHandle}
                  onSubmit={handleEditorSubmit}
                  onCycleMode={handleCycleMode}
                  onToggleShortcuts={handleToggleShortcuts}
                  onCancel={handleCancel}
                  isRunning={streamingState !== 'idle'}
                  disabled={isDisabled || pendingApproval !== null}
                  commands={commands}
                  skills={loadedSkills}
                  slashCommandCategoryOrder={slashCommandCategoryOrder}
                  queuedMessages={queuedTexts}
                  onFocusFooter={handleFocusTaskPill}
                  onPopQueuedMessages={popQueuedPromptsForEdit}
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
                  dialogOpen={interactionBlocked}
                  followupState={followupState}
                  onAcceptFollowup={onAcceptFollowup}
                  onDismissFollowup={onDismissFollowup}
                  composerInput={composerInput}
                  composerInputVersion={composerInputVersion}
                  placeholderText={
                    !connected || connection.catchingUp
                      ? t('common.loading')
                      : streamingState !== 'idle'
                        ? t('editor.processing')
                        : t('editor.placeholder')
                  }
                />
              </div>
              {CustomFooter ? (
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
                      label: m.label,
                      contextWindow: m.contextWindow,
                    }))}
                  skills={loadedSkills}
                  onSelectMode={handleSetMode}
                  onSelectModel={handleModelSelect}
                />
              ) : (
                <StatusBar
                  escapeHint={escapeHintVisible}
                  onSelectMode={() => setShowApprovalModeDialog((v) => !v)}
                  onSelectModel={() =>
                    setModelDialogMode((v) => (v ? null : 'main'))
                  }
                  onShowContext={() => showContextUsage('/context', false)}
                  onOpenSettings={() => setShowSettingsDialog(true)}
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
                <div className={styles.emptyWelcomeFooter}>{welcomeFooter}</div>
              )}
            </div>
          </WebShellCustomizationProvider>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}

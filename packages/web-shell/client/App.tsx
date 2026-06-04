import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useActions,
  useConnection,
  useMessages,
  useDaemonFollowupSuggestion,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptStore,
  useWorkspaceActions,
  type DaemonStreamingState,
} from '@qwen-code/webui/daemon-react-sdk';
import { extractPendingPermission } from './adapters/transcriptAdapter';
import { MessageList } from './components/MessageList';
import { Editor, type EditorHandle } from './components/Editor';
import type { PromptImage } from './adapters/promptTypes';
import { StatusBar } from './components/StatusBar';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { StreamingStatus } from './components/StreamingStatus';
import { TodoPanel } from './components/panels/TodoPanel';
import { ActiveAgentsPanel } from './components/panels/ActiveAgentsPanel';
import { WelcomeHeader } from './components/WelcomeHeader';
import {
  APPROVAL_MODE_ACTIVE_EVENT,
  ApprovalModeMessage,
} from './components/messages/ApprovalModeMessage';
import { ResumeDialog } from './components/dialogs/ResumeDialog';
import {
  AGENTS_ACTIVE_EVENT,
  AgentsMessage,
  type AgentsInitialMode,
} from './components/messages/AgentsMessage';
import {
  MEMORY_ACTIVE_EVENT,
  MemoryMessage,
} from './components/messages/MemoryMessage';
import {
  MODEL_ACTIVE_EVENT,
  ModelMessage,
  type ModelInlineMode,
} from './components/messages/ModelMessage';
import { ToolsDialog } from './components/dialogs/ToolsDialog';
import { HelpDialog } from './components/dialogs/HelpDialog';
import {
  ThemeDialog,
  type WebShellTheme,
} from './components/dialogs/ThemeDialog';
import { DeleteSessionDialog } from './components/dialogs/DeleteSessionDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { getLocalCommands } from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameValue } from './hooks/useAnimationFrameValue';
import { usePanelActive } from './hooks/usePanelActive';
import { useShallowMemo, useStableArray } from './hooks/useShallowMemo';
import {
  I18nProvider,
  getTranslator,
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
import { handleTasksSlashCommand } from './utils/tasksCommand';
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
  serializeMcpStatusMessage,
} from './components/messages/McpStatusMessage';
import { BtwMessage } from './components/messages/BtwMessage';
import type {
  ACPToolCall,
  Message,
  PermissionRequest,
  TodoItem,
} from './adapters/types';
import { extractTodosFromToolCall, hasActiveTodos } from './utils/todos';
import { ThemeProvider } from './themeContext';
import {
  WebShellCustomizationProvider,
  type WebShellMarkdownCustomization,
  type ToolHeaderExtraRenderer,
} from './customization';
import styles from './App.module.css';

export const CompactModeContext = createContext(false);

const MODES_CYCLE = DAEMON_APPROVAL_MODES;
const MAX_DISPLAYED_QUEUED_PROMPTS = 3;
const MAX_QUEUED_PROMPT_PREVIEW_CHARS = 240;
const COMPACT_MODE_STORAGE_KEY = 'web-shell:compact-mode';

function loadCompactMode(): boolean {
  try {
    return window.localStorage.getItem(COMPACT_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveCompactMode(enabled: boolean) {
  try {
    window.localStorage.setItem(
      COMPACT_MODE_STORAGE_KEY,
      enabled ? 'true' : 'false',
    );
  } catch {
    // Ignore storage failures in private browsing or restricted contexts.
  }
}

function normalizeHiddenCommand(command: string): string {
  return command.trim().replace(/^\/+/, '').toLowerCase();
}

interface QueuedPrompt {
  id: number;
  text: string;
  images?: PromptImage[];
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
  /** Visual theme for the embedded shell. Defaults to the dark terminal skin. */
  theme?: 'dark' | 'light';
  /** Called when `/theme` changes the web-shell theme. */
  onThemeChange?: (theme: WebShellTheme) => void;
  /** UI language for the Web terminal. Defaults to `?language=` or browser language. */
  language?: 'en' | 'zh-CN' | 'zh' | 'zh-cn';
  /** Called when `/language ui` changes the web-shell UI language. */
  onLanguageChange?: (language: WebShellLanguage) => void;
  /** Additional CSS class name appended to the root element. */
  className?: string;
  /** Inline styles applied to the root element. */
  style?: React.CSSProperties;
  /** Called when connection status changes (idle/connecting/connected/disconnected/error). */
  onConnectionChange?: (status: string) => void;
  /** Called when prompt status changes (idle/waiting/responding). */
  onStreamingStateChange?: (state: DaemonStreamingState) => void;
  /** Called when a critical error occurs (auth failure, session gone, etc). */
  onError?: (error: Error) => void;
  /** Called when `/bug` is invoked. Receives system info. If omitted, web-shell opens the report URL itself. */
  onBugReport?: (info: BugReportInfo) => void;
  /** Slash command names to hide from completion/help, for example `['approval-mode']`. */
  hiddenSlashCommands?: string[];
  /** Custom renderer for the tool-card header content after the status icon and tool name. */
  renderToolHeaderExtra?: ToolHeaderExtraRenderer;
  /** Custom Markdown behavior for assistant content only. */
  markdown?: WebShellMarkdownCustomization;
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

function isAgentTool(tool: ACPToolCall): boolean {
  const name = tool.toolName.toLowerCase();
  return (
    name === 'agent' || name === 'task' || Boolean(tool.args?.subagent_type)
  );
}

function isActiveTool(tool: ACPToolCall): boolean {
  return tool.status === 'pending' || tool.status === 'in_progress';
}

interface FloatingPanels {
  todos: TodoItem[];
  agents: ACPToolCall[];
}

function getFloatingPanels(messages: readonly Message[]): FloatingPanels {
  let todos: TodoItem[] | undefined;
  const agents: ACPToolCall[] = [];

  for (const message of messages) {
    if (message.role === 'plan') {
      if (hasActiveTodos(message.todos)) {
        todos = message.todos;
      } else {
        todos = [];
      }
      continue;
    }
    if (message.role !== 'tool_group') continue;

    for (const tool of message.tools) {
      const nextTodos = extractTodosFromToolCall(tool);
      if (nextTodos) {
        todos = hasActiveTodos(nextTodos) ? nextTodos : [];
      }
      if (isAgentTool(tool) && isActiveTool(tool)) {
        agents.push(tool);
      }
    }
  }

  return { todos: todos ?? [], agents };
}

function getAgentPanelVersion(agent: ACPToolCall): string {
  const raw = agent.rawOutput;
  const taskExec =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const summary = taskExec?.executionSummary;
  const summaryRecord =
    summary && typeof summary === 'object' && !Array.isArray(summary)
      ? (summary as Record<string, unknown>)
      : undefined;
  return [
    agent.subTools?.length ?? 0,
    agent.subContent?.length ?? 0,
    agent.title ?? '',
    agent.args?.description ?? '',
    agent.args?.prompt ?? '',
    taskExec?.tokenCount ?? '',
    summaryRecord?.totalTokens ?? '',
    summaryRecord?.totalToolCalls ?? '',
    summaryRecord?.failedToolCalls ?? '',
    taskExec?.terminateReason ?? '',
  ].join(':');
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
}: {
  prompts: readonly QueuedPrompt[];
  t: ReturnType<typeof getTranslator>;
}) {
  if (prompts.length === 0) return null;

  return (
    <div className={styles.queuedPrompts}>
      {prompts.slice(0, MAX_DISPLAYED_QUEUED_PROMPTS).map((prompt) => {
        const normalizedPreview = prompt.text.replace(/\s+/g, ' ').trim();
        const preview =
          normalizedPreview.length > MAX_QUEUED_PROMPT_PREVIEW_CHARS
            ? `${normalizedPreview.slice(0, MAX_QUEUED_PROMPT_PREVIEW_CHARS)}...`
            : normalizedPreview;
        const imageCount = prompt.images?.length ?? 0;
        return (
          <div key={prompt.id} className={styles.queuedPrompt}>
            {preview}
            {imageCount > 0
              ? ` ${t('queue.imageCount', { count: imageCount })}`
              : ''}
          </div>
        );
      })}
      {prompts.length > MAX_DISPLAYED_QUEUED_PROMPTS && (
        <div className={styles.queuedPrompt}>
          {t('queue.more', {
            count: prompts.length - MAX_DISPLAYED_QUEUED_PROMPTS,
          })}
        </div>
      )}
      <div className={styles.queuedHint}>{t('queue.footer')}</div>
    </div>
  );
}

export function App({
  onSessionIdChange,
  theme: providedTheme = 'dark',
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
  renderToolHeaderExtra,
  markdown,
}: WebShellProps = {}) {
  const [selectedLanguage, setSelectedLanguage] = useState<WebShellLanguage>(
    () =>
      providedLanguage === undefined
        ? getInitialLanguage()
        : normalizeLanguage(providedLanguage),
  );
  const t = useMemo(() => getTranslator(selectedLanguage), [selectedLanguage]);
  const customization = useMemo(
    () => ({ renderToolHeaderExtra, markdown }),
    [renderToolHeaderExtra, markdown],
  );
  const store = useTranscriptStore();
  const blocks = useTranscriptBlocks();
  const connection = useConnection();
  const sessionActions = useActions();
  const workspaceActions = useWorkspaceActions();

  const messages = useMessages();
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [recapMessage, setRecapMessage] = useState<LocalAnchoredMessage | null>(
    null,
  );
  const [btwMessage, setBtwMessage] = useState<Message | null>(null);
  const nextRecapMessageIdRef = useRef(1);
  const nextBtwMessageIdRef = useRef(1);
  const btwAbortControllerRef = useRef<AbortController | null>(null);
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
  const pendingApprovalRef = useRef(pendingApproval);
  pendingApprovalRef.current = pendingApproval;
  const shouldHideComposer = pendingApproval !== null;
  const rawFloatingPanels = useMemo(
    () => getFloatingPanels(messages),
    [messages],
  );
  const floatingTodos = useStableArray(
    rawFloatingPanels.todos,
    (t) => `${t.id}:${t.status}:${t.content}`,
  );
  const floatingAgents = useStableArray(
    rawFloatingPanels.agents,
    (a) =>
      `${a.callId}:${a.status}:${a.subTools?.length ?? 0}:${getAgentPanelVersion(a)}`,
  );
  const activeAgentsPanelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorHandle>(null);
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
      opts?: { optimisticUserMessage?: boolean },
    ) => {
      clearFollowup();
      return sessionActions.sendPrompt(text, {
        images,
        optimisticUserMessage: opts?.optimisticUserMessage,
      });
    },
    [clearFollowup, sessionActions],
  );
  const streamingState = useStreamingState();
  const streamingStateRef = useRef<DaemonStreamingState>(streamingState);
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

  const [modelInlineMode, setModelInlineMode] =
    useState<ModelInlineMode | null>(null);
  const [approvalModeInlineOpen, setApprovalModeInlineOpen] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showToolsDialog, setShowToolsDialog] = useState(false);
  const [memoryInlineOpen, setMemoryInlineOpen] = useState(false);
  const [memoryRefreshSignal, setMemoryRefreshSignal] = useState(0);
  const [memoryAddSignal, setMemoryAddSignal] = useState(0);
  const [memoryAddScope, setMemoryAddScope] = useState<'workspace' | 'global'>(
    'workspace',
  );
  const [agentsInlineMode, setAgentsInlineMode] =
    useState<AgentsInitialMode | null>(null);
  const [memoryPortalHost, setMemoryPortalHost] =
    useState<HTMLDivElement | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const approvalModePanelActive = usePanelActive(APPROVAL_MODE_ACTIVE_EVENT);
  const mcpPanelActive = usePanelActive(MCP_STATUS_ACTIVE_EVENT);
  const agentsPanelActive = usePanelActive(AGENTS_ACTIVE_EVENT);
  const memoryPanelActive = usePanelActive(MEMORY_ACTIVE_EVENT);
  const modelPanelActive = usePanelActive(MODEL_ACTIVE_EVENT);
  const [selectedTheme, setSelectedTheme] =
    useState<WebShellTheme>(providedTheme);
  const [currentModel, setCurrentModel] = useState('');
  const currentModelRef = useRef(currentModel);
  currentModelRef.current = currentModel;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [currentMode, setCurrentMode] = useState('default');
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const nextQueuedPromptIdRef = useRef(1);
  const drainingQueueRef = useRef(false);
  const dialogOpen =
    showResumeDialog ||
    showDeleteDialog ||
    showReleaseDialog ||
    showHelpDialog ||
    showThemeDialog ||
    showToolsDialog;
  const bottomHidden =
    dialogOpen ||
    approvalModePanelActive ||
    mcpPanelActive ||
    agentsPanelActive ||
    memoryPanelActive ||
    modelPanelActive;

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      store.dispatch([{ type: 'error', text: formatError(error, fallback) }]);
    },
    [store],
  );

  const onBugReportRef = useRef(onBugReport);
  onBugReportRef.current = onBugReport;

  useEffect(() => {
    activeSessionIdRef.current = connection.sessionId;
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setRecapMessage(null);
    setBtwMessage(null);
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
        setRecapMessage({
          anchorAfterId,
          anchorIndex,
          message: {
            id: messageId,
            role: 'system',
            content: formatError(error, t('recap.failed')),
            variant: 'error',
          },
        });
      },
    );
  }, [connection.sessionId, messages, sessionActions, t]);

  const runVisibleBtw = useCallback(
    (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question) {
        store.dispatch([
          {
            type: 'error',
            text: t('btw.empty'),
          },
        ]);
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
            setBtwMessage({
              id: messageId,
              role: 'btw',
              question,
              answer: formatError(error, t('btw.failed')),
              isPending: false,
            });
          },
        );
    },
    [connection.sessionId, sessionActions, store, t],
  );

  const dismissBtwMessage = useCallback(() => {
    btwAbortControllerRef.current?.abort();
    btwAbortControllerRef.current = null;
    setBtwMessage(null);
  }, []);

  useEffect(() => {
    const onBtwShortcut = (e: KeyboardEvent) => {
      if (bottomHidden || pendingApproval) return;
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
        const editorHasText =
          (editorRef.current?.getText().trim().length ?? 0) > 0;
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
  }, [bottomHidden, btwMessage, dismissBtwMessage, pendingApproval]);

  useEffect(() => {
    queuedPromptsRef.current = queuedPrompts;
  }, [queuedPrompts]);

  const enqueuePrompt = useCallback((text: string, images?: PromptImage[]) => {
    const trimmed = text.trim();
    if (!trimmed) return true;
    const nextPrompt: QueuedPrompt = {
      id: nextQueuedPromptIdRef.current++,
      text: trimmed,
      images: images ? [...images] : undefined,
    };
    queuedPromptsRef.current = [...queuedPromptsRef.current, nextPrompt];
    setQueuedPrompts(queuedPromptsRef.current);
    return true;
  }, []);

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
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    return current.map((prompt) => prompt.text).join('\n\n');
  }, []);

  const clearQueuedPrompts = useCallback((): boolean => {
    if (queuedPromptsRef.current.length === 0) return false;
    queuedPromptsRef.current = [];
    setQueuedPrompts([]);
    store.dispatch([{ type: 'status', text: t('queue.cleared') }]);
    return true;
  }, [store, t]);

  useEffect(() => {
    setSelectedTheme(providedTheme);
  }, [providedTheme]);

  const handleThemeChange = useCallback(
    (nextTheme: WebShellTheme) => {
      setSelectedTheme(nextTheme);
      onThemeChange?.(nextTheme);
    },
    [onThemeChange],
  );

  useEffect(() => {
    if (providedLanguage !== undefined) {
      setSelectedLanguage(normalizeLanguage(providedLanguage));
    }
  }, [providedLanguage]);

  const handleToggleShortcuts = useCallback(() => {
    setShowShortcuts((prev) => !prev);
  }, []);

  const [compactMode, setCompactMode] = useState(loadCompactMode);
  const compactModeRef = useRef(compactMode);
  compactModeRef.current = compactMode;

  const handleClearScreen = useCallback(() => {
    if (streamingStateRef.current !== 'idle') {
      store.dispatch([{ type: 'status', text: t('clear.blocked') }]);
      return;
    }
    store.reset();
  }, [store, t]);

  const handleToggleCompact = useCallback(() => {
    const next = !compactModeRef.current;
    setCompactMode(next);
    saveCompactMode(next);
  }, []);

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
          if (effectiveMode === 'auto') {
            // TODO: CLI also shows stripped dangerous allow rules via
            // PermissionManager.getStrippedDangerousRules(). The daemon
            // API (DaemonApprovalModeResult) doesn't expose this info yet.
            // Once the daemon returns strippedRules in the response, display
            // them here like CLI's emitAutoModeEntryNotices does.
            store.dispatch([{ type: 'status', text: t('mode.auto.notice') }]);
          }
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
    onStreamingStateChange?.(streamingState);
  }, [streamingState, onStreamingStateChange]);

  useEffect(() => {
    onConnectionChange?.(connection.status);
  }, [connection.status, onConnectionChange]);

  useEffect(() => {
    if (connection.error) {
      onError?.(new Error(connection.error));
    }
  }, [connection.error, onError]);

  useEffect(() => {
    if (connection.currentModel) {
      setCurrentModel(connection.currentModel);
    }
  }, [connection.currentModel]);

  useEffect(() => {
    if (connection.currentMode) {
      setCurrentMode(connection.currentMode);
    }
  }, [connection.currentMode]);

  useEffect(() => {
    if (connection.sessionId) {
      onSessionIdChange?.(connection.sessionId);
      if (!onSessionIdChange) {
        replaceSessionUrl(connection.sessionId);
      }
    }
  }, [connection.sessionId, onSessionIdChange]);

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
          console.warn('[auto-recap] failed:', error);
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

  const handleSubmit = useCallback(
    (text: string, images?: PromptImage[]) => {
      const promptBlocked = streamingStateRef.current !== 'idle';
      if (text.startsWith('/')) {
        const match = text.match(/^\/([\w-]+)/);
        if (match) {
          const cmd = match[1];
          if (cmd === 'help') {
            setShowHelpDialog(true);
            return true;
          }
          if (
            handleTasksSlashCommand({
              cmd,
              promptBlocked,
              getTasks: sessionActions.getTasks,
              dispatch: store.dispatch,
              reportError,
            })
          ) {
            return true;
          }
          if (cmd === 'theme') {
            const themeArg = text.slice(match[0].length).trim().toLowerCase();
            if (themeArg === 'dark' || themeArg === 'light') {
              handleThemeChange(themeArg);
            } else if (!themeArg) {
              setShowThemeDialog(true);
            } else {
              store.dispatch([
                {
                  type: 'error',
                  text: t('error.unsupportedTheme'),
                },
              ]);
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
                store.dispatch([
                  { type: 'error', text: t('language.invalid') },
                ]);
                return true;
              }
              const nextLanguage = normalizeLanguage(languageArg);
              setSelectedLanguage(nextLanguage);
              onLanguageChange?.(nextLanguage);
              if (!promptBlocked) {
                sendPrompt(`/language ui ${nextLanguage}`, undefined, {
                  optimisticUserMessage: false,
                })
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
          if (cmd === 'model') {
            const modelArg = text.slice(match[0].length).trim();
            if (modelArg === '--fast') {
              store.appendLocalUserMessage(text);
              setModelInlineMode('fast');
              return true;
            }
            if (modelArg.startsWith('--fast ')) {
              if (promptBlocked) return enqueuePrompt(text, images);
              sendPrompt(text, images).catch((error: unknown) =>
                reportError(error, 'Failed to send /model --fast'),
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
              store.appendLocalUserMessage(text);
              setModelInlineMode('main');
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
              store.appendLocalUserMessage(text);
              setApprovalModeInlineOpen(true);
            }
            return true;
          }
          if (cmd === 'mcp') {
            const mcpArg = text.slice(match[0].length).trim().toLowerCase();
            store.appendLocalUserMessage(text);
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
                store.dispatch([
                  {
                    type: 'status',
                    text: serializeMcpStatusMessage({
                      status,
                      toolsByServer,
                      showDescriptions: mcpArg === 'desc',
                      showSchema: mcpArg === 'schema',
                      showTips: !mcpArg,
                    }),
                  },
                ]);
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
                })
                .catch((error: unknown) => {
                  reportError(error, 'Failed to load tools');
                });
            }
            return true;
          }
          if (cmd === 'context') {
            const contextArg = text.slice(match[0].length).trim().toLowerCase();
            if (
              contextArg === '' ||
              contextArg === 'detail' ||
              contextArg === '-d'
            ) {
              store.appendLocalUserMessage(text);
              sessionActions
                .getContextUsage({
                  detail: contextArg === 'detail' || contextArg === '-d',
                })
                .then((result) => {
                  store.dispatch([
                    {
                      type: 'status',
                      text: serializeContextUsageMessage(result),
                    },
                  ]);
                })
                .catch((error: unknown) => {
                  reportError(error, 'Failed to load context usage');
                });
              return true;
            }
          }
          if (cmd === 'memory') {
            const memoryArg = text.slice(match[0].length).trim().toLowerCase();
            store.appendLocalUserMessage(text);
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
            setMemoryInlineOpen(true);
            return true;
          }
          if (cmd === 'agents') {
            const subCommand = text.slice(match[0].length).trim().toLowerCase();
            store.appendLocalUserMessage(text);
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
            setAgentsInlineMode(agentsMode);
            return true;
          }
          if (cmd === 'clear') {
            sessionActions.newSession().catch((error: unknown) => {
              reportError(error, 'Failed to create a new session');
            });
            return true;
          }
          if (cmd === 'new' || cmd === 'reset') {
            sessionActions.newSession().catch((error: unknown) => {
              reportError(error, 'Failed to create a new session');
            });
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
              store.dispatch([
                {
                  type: 'error',
                  text: t('rename.empty'),
                },
              ]);
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
                store.dispatch([
                  {
                    type: 'error',
                    text:
                      error instanceof Error
                        ? error.message
                        : 'Failed to rename session',
                  },
                ]);
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
                    store.dispatch([
                      { type: 'error', text: t('bug.popupBlocked') },
                    ]);
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
      handleThemeChange,
      handleSetMode,
      onLanguageChange,
      reportError,
      runVisibleRecap,
      runVisibleBtw,
      selectedLanguage,
      t,
      workspaceActions,
    ],
  );

  useEffect(() => {
    if (drainingQueueRef.current) return;
    if (!connected) return;
    if (streamingState !== 'idle') return;
    if (bottomHidden) return;
    if (pendingApproval) return;
    if (queuedPrompts.length === 0) return;

    const nextPrompt = popNextQueuedPrompt();
    if (!nextPrompt) return;

    drainingQueueRef.current = true;
    const timer = window.setTimeout(() => {
      try {
        handleSubmit(nextPrompt.text, nextPrompt.images);
      } finally {
        drainingQueueRef.current = false;
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      drainingQueueRef.current = false;
    };
  }, [
    connected,
    bottomHidden,
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
    sessionActions
      .cancel()
      .then(() => {
        store.dispatch([{ type: 'status', text: t('request.cancelled') }]);
      })
      .catch((error: unknown) => {
        reportError(error, 'Failed to cancel request');
      });
  }, [sessionActions, store, t, reportError]);

  const handleFocusActiveAgents = useCallback((): boolean => {
    if (floatingAgents.length === 0) return false;
    editorRef.current?.blur();
    window.setTimeout(() => {
      activeAgentsPanelRef.current?.focus({ preventScroll: true });
    }, 0);
    return true;
  }, [floatingAgents.length]);

  const handleReturnToEditor = useCallback((text?: string) => {
    if (text) {
      editorRef.current?.insertText(text);
      return;
    }
    editorRef.current?.focus();
  }, []);

  useEffect(() => {
    const onGlobalShortcut = (e: KeyboardEvent) => {
      if (bottomHidden) return;
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
          editorRef.current?.retryLast();
          return;
        }
      }
    };
    window.addEventListener('keydown', onGlobalShortcut, true);
    return () => window.removeEventListener('keydown', onGlobalShortcut, true);
  }, [bottomHidden, handleClearScreen, handleToggleCompact]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Tab' && e.shiftKey && !bottomHidden) {
        e.preventDefault();
        handleCycleMode();
        return;
      }
      if (
        e.key === 'Escape' &&
        !pendingApproval &&
        !bottomHidden &&
        clearQueuedPrompts()
      ) {
        e.preventDefault();
        return;
      }
      if (
        e.key === 'Escape' &&
        streamingState !== 'idle' &&
        !pendingApproval &&
        !bottomHidden
      ) {
        handleCancel();
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    streamingState,
    handleCancel,
    handleCycleMode,
    pendingApproval,
    bottomHidden,
    clearQueuedPrompts,
  ]);

  const isDisabled = !connected;

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
      if (streamingState !== 'idle') return;
      sendPrompt(`/model --fast ${modelId}`).catch((error: unknown) => {
        reportError(error, 'Failed to switch fast model');
      });
    },
    [sendPrompt, streamingState, reportError],
  );

  const commands = useMemo(() => {
    const skillNames = new Set(connection.skills ?? []);
    const hidden = new Set(
      (hiddenSlashCommands ?? []).map(normalizeHiddenCommand).filter(Boolean),
    );
    return mergeCommands(connection.commands ?? [], getLocalCommands(t))
      .filter((command) => !hidden.has(normalizeHiddenCommand(command.name)))
      .map((command) =>
        skillNames.has(command.name)
          ? { ...command, description: t('skills.run') }
          : command,
      );
  }, [connection.commands, connection.skills, hiddenSlashCommands, t]);

  const welcomeHeader = useMemo(
    () => (
      <WelcomeHeader
        version={connection.capabilities?.qwenCodeVersion || ''}
        cwd={connection.workspaceCwd || ''}
        currentModel={currentModel}
        currentMode={currentMode}
      />
    ),
    [
      connection.capabilities?.qwenCodeVersion,
      connection.workspaceCwd,
      currentModel,
      currentMode,
    ],
  );

  const appClassName = [
    styles.app,
    selectedTheme === 'light' ? styles.themeLight : styles.themeDark,
    externalClassName,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <ThemeProvider value={selectedTheme}>
      <I18nProvider language={selectedLanguage}>
        <div className={appClassName} style={externalStyle} data-web-shell-root>
          {dialogOpen && (
            <div className={styles.dialogOverlay} data-keyboard-scope>
              {showResumeDialog && (
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
              )}
              {showDeleteDialog && (
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
                    const reason =
                      error instanceof Error ? error.message : String(error);
                    store.dispatch([
                      {
                        type: 'error',
                        text: t('delete.failed', { reason }),
                      },
                    ]);
                  }}
                  onClose={() => setShowDeleteDialog(false)}
                />
              )}
              {showReleaseDialog && (
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
                    const reason =
                      error instanceof Error ? error.message : String(error);
                    store.dispatch([
                      {
                        type: 'error',
                        text: t('release.failed', { reason }),
                      },
                    ]);
                  }}
                  onClose={() => setShowReleaseDialog(false)}
                />
              )}
              {showHelpDialog && (
                <HelpDialog
                  commands={commands}
                  onClose={() => setShowHelpDialog(false)}
                />
              )}
              {showThemeDialog && (
                <ThemeDialog
                  currentTheme={selectedTheme}
                  onSelect={handleThemeChange}
                  onClose={() => setShowThemeDialog(false)}
                />
              )}
              {showToolsDialog && (
                <ToolsDialog onClose={() => setShowToolsDialog(false)} />
              )}
            </div>
          )}

          <WebShellCustomizationProvider value={customization}>
            <CompactModeContext.Provider value={compactMode}>
              <div
                className={
                  floatingTodos.length > 0 || floatingAgents.length > 0
                    ? `${styles.content} ${styles.contentHasMessages}`
                    : styles.content
                }
                style={dialogOpen ? { visibility: 'hidden' } : undefined}
              >
                <MessageList
                  messages={displayMessages}
                  pendingApproval={pendingApproval}
                  onConfirm={handleConfirm}
                  catchingUp={connection.catchingUp}
                  workspaceCwd={connection.workspaceCwd || ''}
                  welcomeHeader={welcomeHeader}
                  tailContent={
                    agentsInlineMode ||
                    memoryInlineOpen ||
                    modelInlineMode ||
                    approvalModeInlineOpen ? (
                      <>
                        {approvalModeInlineOpen && (
                          <ApprovalModeMessage
                            currentMode={currentMode}
                            onSelect={handleSetMode}
                            onClose={() => setApprovalModeInlineOpen(false)}
                          />
                        )}
                        {modelInlineMode && (
                          <ModelMessage
                            mode={modelInlineMode}
                            onSelect={
                              modelInlineMode === 'fast'
                                ? handleFastModelSelect
                                : handleModelSelect
                            }
                            onClose={() => setModelInlineMode(null)}
                          />
                        )}
                        {agentsInlineMode && (
                          <AgentsMessage
                            mode={agentsInlineMode}
                            onMessage={(text) =>
                              store.dispatch([{ type: 'status', text }])
                            }
                            onClose={() => setAgentsInlineMode(null)}
                          />
                        )}
                        {memoryInlineOpen && (
                          <MemoryMessage
                            refreshSignal={memoryRefreshSignal}
                            addSignal={memoryAddSignal}
                            addScope={memoryAddScope}
                            portalHost={memoryPortalHost}
                            onMessage={(text, type = 'status') => {
                              store.dispatch([{ type, text }]);
                            }}
                            onClose={() => setMemoryInlineOpen(false)}
                          />
                        )}
                      </>
                    ) : undefined
                  }
                  tailKey={
                    agentsInlineMode ||
                    memoryInlineOpen ||
                    modelInlineMode ||
                    approvalModeInlineOpen
                      ? `inline-${modelInlineMode ?? 'none'}-${agentsInlineMode ?? 'none'}-${memoryInlineOpen ? 'memory' : 'none'}-${approvalModeInlineOpen ? 'approval' : 'none'}`
                      : undefined
                  }
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

                <StreamingStatus />
              </div>
              <div ref={setMemoryPortalHost} data-web-shell-overlay-root />
            </CompactModeContext.Provider>
          </WebShellCustomizationProvider>

          <div
            className={
              bottomHidden
                ? `${styles.footer} ${styles.footerHidden}`
                : styles.footer
            }
          >
            {floatingTodos.length > 0 && (
              <div className={styles.bottomPanels}>
                <TodoPanel todos={floatingTodos} />
              </div>
            )}
            {!shouldHideComposer && (
              <div className={styles.composer}>
                <QueuedPromptDisplay prompts={queuedPrompts} t={t} />
                <Editor
                  ref={editorRef}
                  onSubmit={handleSubmit}
                  onCycleMode={handleCycleMode}
                  onToggleShortcuts={handleToggleShortcuts}
                  disabled={isDisabled}
                  commands={commands}
                  skills={loadedSkills}
                  queuedMessages={queuedPrompts.map((prompt) => prompt.text)}
                  onFocusActiveAgents={handleFocusActiveAgents}
                  onPopQueuedMessages={popQueuedPromptsForEdit}
                  onClearQueuedMessages={clearQueuedPrompts}
                  currentMode={currentMode}
                  dialogOpen={bottomHidden}
                  followupState={followupState}
                  onAcceptFollowup={onAcceptFollowup}
                  onDismissFollowup={onDismissFollowup}
                  placeholderText={
                    !connected
                      ? t('common.loading')
                      : streamingState !== 'idle'
                        ? t('editor.processing')
                        : t('editor.placeholder')
                  }
                />
              </div>
            )}
            {!shouldHideComposer &&
              (showShortcuts ? <ShortcutsPanel /> : <StatusBar />)}

            {floatingAgents.length > 0 && (
              <div className={styles.bottomPanels}>
                <ActiveAgentsPanel
                  ref={activeAgentsPanelRef}
                  agents={floatingAgents}
                  onReturnToInput={handleReturnToEditor}
                />
              </div>
            )}
          </div>
        </div>
      </I18nProvider>
    </ThemeProvider>
  );
}

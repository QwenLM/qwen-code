import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useActions,
  useConnection,
  useMessages,
  useDaemonFollowupSuggestion,
  useStreamingState,
  useTranscriptBlocks,
  useTranscriptStore,
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
import { ModelDialog } from './components/dialogs/ModelDialog';
import { ApprovalModeDialog } from './components/dialogs/ApprovalModeDialog';
import { ResumeDialog } from './components/dialogs/ResumeDialog';
import { McpDialog } from './components/dialogs/McpDialog';
import { MemoryDialog } from './components/dialogs/MemoryDialog';
import type { MemoryDialogInitialMode } from './components/dialogs/MemoryDialog';
import { AgentsDialog } from './components/dialogs/AgentsDialog';
import type { AgentsDialogInitialMode } from './components/dialogs/AgentsDialog';
import { SkillsDialog } from './components/dialogs/SkillsDialog';
import { ToolsDialog } from './components/dialogs/ToolsDialog';
import { HelpDialog } from './components/dialogs/HelpDialog';
import {
  ThemeDialog,
  type WebShellTheme,
} from './components/dialogs/ThemeDialog';
import { ReleaseSessionDialog } from './components/dialogs/ReleaseSessionDialog';
import { getLocalCommands } from './constants/localCommands';
import { mergeCommands } from './hooks/daemonSessionMappers';
import { useAnimationFrameValue } from './hooks/useAnimationFrameValue';
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
import { handleTasksSlashCommand } from './utils/tasksCommand';
import {
  DAEMON_APPROVAL_MODES,
  type DaemonApprovalMode,
} from '@qwen-code/webui/daemon-react-sdk';
import { serializeContextUsageMessage } from './components/messages/ContextUsageMessage';
import type { ACPToolCall, Message, TodoItem } from './adapters/types';
import { extractTodosFromToolCall, hasActiveTodos } from './utils/todos';
import { ThemeProvider } from './themeContext';
import styles from './App.module.css';

const WEB_SHELL_VERSION = __WEB_SHELL_VERSION__;
const MODES_CYCLE = DAEMON_APPROVAL_MODES;
const MAX_DISPLAYED_QUEUED_PROMPTS = 3;

interface QueuedPrompt {
  id: number;
  text: string;
  images?: PromptImage[];
}

interface LocalRecapMessage {
  anchorAfterId?: string;
  anchorIndex: number;
  message: Message;
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
}

function replaceSessionUrl(sessionId: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.pathname = `/session/${encodeURIComponent(sessionId)}`;
  url.searchParams.delete('token');
  url.searchParams.delete('daemon');
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

function isDaemonApprovalMode(mode: string): mode is DaemonApprovalMode {
  return DAEMON_APPROVAL_MODES.includes(mode as DaemonApprovalMode);
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

function getFloatingTodos(messages: readonly Message[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'plan') {
      return hasActiveTodos(message.todos) ? message.todos : [];
    }
    if (message.role === 'tool_group') {
      for (let j = message.tools.length - 1; j >= 0; j--) {
        const todos = extractTodosFromToolCall(message.tools[j]);
        if (todos) {
          return hasActiveTodos(todos) ? todos : [];
        }
      }
    }
  }
  return [];
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

function getFloatingAgents(messages: readonly Message[]): ACPToolCall[] {
  return messages.flatMap((message) => {
    if (message.role !== 'tool_group') return [];
    return message.tools.filter(
      (tool) => isAgentTool(tool) && isActiveTool(tool),
    );
  });
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
        const preview = prompt.text.replace(/\s+/g, ' ');
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
}: WebShellProps = {}) {
  const [selectedLanguage, setSelectedLanguage] = useState<WebShellLanguage>(
    () =>
      providedLanguage === undefined
        ? getInitialLanguage()
        : normalizeLanguage(providedLanguage),
  );
  const t = useMemo(() => getTranslator(selectedLanguage), [selectedLanguage]);
  const store = useTranscriptStore();
  const blocks = useTranscriptBlocks();
  const connection = useConnection();
  const sessionActions = useActions();

  const messages = useMessages();
  const [recapMessage, setRecapMessage] = useState<LocalRecapMessage | null>(
    null,
  );
  const nextRecapMessageIdRef = useRef(1);
  const activeSessionIdRef = useRef(connection.sessionId);
  const displayMessages = useMemo(() => {
    if (!recapMessage) return messages;
    const anchorIndex = recapMessage.anchorAfterId
      ? messages.findIndex(
          (message) => message.id === recapMessage.anchorAfterId,
        )
      : -1;
    const index =
      anchorIndex >= 0
        ? anchorIndex + 1
        : Math.min(recapMessage.anchorIndex, messages.length);
    return [
      ...messages.slice(0, index),
      recapMessage.message,
      ...messages.slice(index),
    ];
  }, [messages, recapMessage]);
  const messageBlocks = useAnimationFrameValue(blocks);
  const pendingApproval = useMemo(
    () => extractPendingPermission(messageBlocks),
    [messageBlocks],
  );
  const shouldHideComposer = pendingApproval !== null;
  const floatingTodos = useMemo(() => getFloatingTodos(messages), [messages]);
  const floatingAgents = useMemo(() => getFloatingAgents(messages), [messages]);
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

  const [modelDialogMode, setModelDialogMode] = useState<
    'main' | 'fast' | null
  >(null);
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [showResumeDialog, setShowResumeDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [showMcpDialog, setShowMcpDialog] = useState(false);
  const [showHelpDialog, setShowHelpDialog] = useState(false);
  const [showThemeDialog, setShowThemeDialog] = useState(false);
  const [showSkillsDialog, setShowSkillsDialog] = useState(false);
  const [showToolsDialog, setShowToolsDialog] = useState(false);
  const [memoryDialogMode, setMemoryDialogMode] =
    useState<MemoryDialogInitialMode | null>(null);
  const [agentsDialogMode, setAgentsDialogMode] =
    useState<AgentsDialogInitialMode | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [selectedTheme, setSelectedTheme] =
    useState<WebShellTheme>(providedTheme);
  const [currentModel, setCurrentModel] = useState('');
  const [currentMode, setCurrentMode] = useState('default');
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const queuedPromptsRef = useRef<QueuedPrompt[]>([]);
  const nextQueuedPromptIdRef = useRef(1);
  const drainingQueueRef = useRef(false);
  const dialogOpen =
    !!modelDialogMode ||
    showModeDialog ||
    showResumeDialog ||
    showReleaseDialog ||
    showMcpDialog ||
    showHelpDialog ||
    showThemeDialog ||
    showSkillsDialog ||
    showToolsDialog ||
    !!memoryDialogMode ||
    !!agentsDialogMode;

  const reportError = useCallback(
    (error: unknown, fallback: string) => {
      store.dispatch([{ type: 'error', text: formatError(error, fallback) }]);
    },
    [store],
  );

  useEffect(() => {
    activeSessionIdRef.current = connection.sessionId;
    setRecapMessage(null);
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
          setCurrentMode(result.mode || modeId);
        })
        .catch((error: unknown) => {
          reportError(error, t('local.approvalMode'));
        });
    },
    [sessionActions, reportError, t],
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
              getTasks: actions.getTasks,
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
            copyFromLastAssistantMessage(messages, copyArg)
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
          if (cmd === 'release') {
            setShowReleaseDialog(true);
            return true;
          }
          if (cmd === 'model') {
            const modelArg = text.slice(match[0].length).trim();
            if (modelArg === '--fast') {
              if (promptBlocked) return false;
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
          if (cmd === 'approval-mode' || cmd === 'mode') {
            const modeArg = text.slice(match[0].length).trim();
            if (modeArg) {
              handleSetMode(modeArg);
            } else {
              setShowModeDialog(true);
            }
            return true;
          }
          if (cmd === 'mcp') {
            setShowMcpDialog(true);
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
              setShowSkillsDialog(true);
            }
            return true;
          }
          if (cmd === 'tools') {
            setShowToolsDialog(true);
            return true;
          }
          if (cmd === 'context') {
            const contextArg = text.slice(match[0].length).trim().toLowerCase();
            if (
              contextArg === '' ||
              contextArg === 'detail' ||
              contextArg === '-d'
            ) {
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
            if (memoryArg === 'show') {
              setMemoryDialogMode('show');
            } else if (memoryArg === 'refresh') {
              setMemoryDialogMode('refresh');
            } else if (memoryArg === 'add user' || memoryArg === 'add global') {
              setMemoryDialogMode('add-user');
            } else if (
              memoryArg === 'add project' ||
              memoryArg === 'add workspace'
            ) {
              setMemoryDialogMode('add-project');
            } else if (memoryArg.startsWith('add')) {
              setMemoryDialogMode('add');
            } else {
              setMemoryDialogMode('menu');
            }
            return true;
          }
          if (cmd === 'agents') {
            const subCommand = text.slice(match[0].length).trim().toLowerCase();
            if (subCommand === 'create') {
              setAgentsDialogMode('create');
            } else if (
              subCommand === 'create user' ||
              subCommand === 'create global'
            ) {
              setAgentsDialogMode('create-user');
            } else if (
              subCommand === 'create project' ||
              subCommand === 'create workspace'
            ) {
              setAgentsDialogMode('create-project');
            } else if (subCommand === 'manage') {
              setAgentsDialogMode('manage');
            } else {
              setAgentsDialogMode('menu');
            }
            return true;
          }
          if (cmd === 'clear') {
            store.reset();
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
        sessionActions
          .sendShellCommand(cmd)
          .catch((error: unknown) => {
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
      messages,
      onLanguageChange,
      reportError,
      runVisibleRecap,
      selectedLanguage,
      t,
    ],
  );

  useEffect(() => {
    if (drainingQueueRef.current) return;
    if (!connected) return;
    if (streamingState !== 'idle') return;
    if (dialogOpen) return;
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
    dialogOpen,
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Tab' && e.shiftKey && pendingApproval && !dialogOpen) {
        e.preventDefault();
        const allowAlways = pendingApproval.options.find(
          (o) => o.kind === 'allow_always',
        );
        if (allowAlways) {
          handleConfirm(pendingApproval.id, allowAlways.id);
        }
        return;
      }
      if (
        e.key === 'Escape' &&
        !pendingApproval &&
        !dialogOpen &&
        clearQueuedPrompts()
      ) {
        e.preventDefault();
        return;
      }
      if (
        e.key === 'Escape' &&
        streamingState !== 'idle' &&
        !pendingApproval &&
        !dialogOpen
      ) {
        handleCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    streamingState,
    handleCancel,
    handleConfirm,
    handleSetMode,
    pendingApproval,
    dialogOpen,
    clearQueuedPrompts,
  ]);

  const isDisabled = !connected;

  const handleModelSelect = useCallback(
    (modelId: string) => {
      sessionActions
        .setModel(modelId)
        .then(() => {
          setCurrentModel(modelId);
        })
        .catch((error: unknown) => {
          reportError(error, t('model.switch'));
        });
    },
    [sessionActions, reportError, t],
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
    return mergeCommands(connection.commands ?? [], getLocalCommands(t)).map(
      (command) =>
        skillNames.has(command.name)
          ? { ...command, description: t('skills.run') }
          : command,
    );
  }, [connection.commands, connection.skills, t]);

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
        <div className={appClassName} style={externalStyle}>
          {dialogOpen && (
            <div className={styles.dialogOverlay} data-keyboard-scope>
              {modelDialogMode && (
                <ModelDialog
                  mode={modelDialogMode}
                  onSelect={
                    modelDialogMode === 'fast'
                      ? handleFastModelSelect
                      : handleModelSelect
                  }
                  onClose={() => setModelDialogMode(null)}
                />
              )}
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
              {showModeDialog && (
                <ApprovalModeDialog
                  currentMode={currentMode}
                  onSelect={handleSetMode}
                  onClose={() => setShowModeDialog(false)}
                />
              )}
              {showMcpDialog && (
                <McpDialog onClose={() => setShowMcpDialog(false)} />
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
              {showSkillsDialog && (
                <SkillsDialog onClose={() => setShowSkillsDialog(false)} />
              )}
              {showToolsDialog && (
                <ToolsDialog onClose={() => setShowToolsDialog(false)} />
              )}
              {memoryDialogMode && (
                <MemoryDialog
                  initialMode={memoryDialogMode}
                  onMessage={(text, type = 'status') => {
                    store.dispatch([{ type, text }]);
                  }}
                  onClose={() => setMemoryDialogMode(null)}
                />
              )}
              {agentsDialogMode && (
                <AgentsDialog
                  initialMode={agentsDialogMode}
                  onClose={() => setAgentsDialogMode(null)}
                />
              )}
            </div>
          )}

          <div
            className={
              displayMessages.length > 0 || streamingState !== 'idle'
                ? `${styles.content} ${styles.contentHasMessages}`
                : styles.content
            }
            style={dialogOpen ? { visibility: 'hidden' } : undefined}
          >
            <MessageList
              messages={displayMessages}
              pendingApproval={pendingApproval}
              onConfirm={handleConfirm}
              welcomeHeader={
                <WelcomeHeader
                  version={WEB_SHELL_VERSION}
                  cwd={connection.workspaceCwd || ''}
                  currentModel={currentModel}
                  currentMode={currentMode}
                />
              }
            />

            <StreamingStatus />
          </div>

          <div
            className={styles.footer}
            style={dialogOpen ? { visibility: 'hidden' } : undefined}
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
                  skills={connection.skills ?? []}
                  queuedMessages={queuedPrompts.map((prompt) => prompt.text)}
                  onFocusActiveAgents={handleFocusActiveAgents}
                  onPopQueuedMessages={popQueuedPromptsForEdit}
                  onClearQueuedMessages={clearQueuedPrompts}
                  currentMode={currentMode}
                  dialogOpen={dialogOpen}
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



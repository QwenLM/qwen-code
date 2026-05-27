import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDaemonSession } from './hooks/useDaemonSession';
import {
  transcriptBlocksToMessages,
  extractPendingPermission,
  extractStreamingState,
} from './adapters/transcriptAdapter';
import { MessageList } from './components/MessageList';
import { Editor } from './components/Editor';
import type { PromptImage } from './adapters/promptTypes';
import { StatusBar } from './components/StatusBar';
import { ShortcutsPanel } from './components/ShortcutsPanel';
import { StreamingStatus } from './components/StreamingStatus';
import { TodoPanel } from './components/panels/TodoPanel';
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
import { getDaemonBaseUrl, getDaemonToken } from './config/daemon';
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
} from '@qwen-code/sdk/daemon';
import type { Message, StreamingState, TodoItem } from './adapters/types';
import { extractTodosFromToolCall, hasActiveTodos } from './utils/todos';
import styles from './App.module.css';

const DAEMON_BASE_URL = getDaemonBaseUrl();
const DAEMON_TOKEN = getDaemonToken();
const WEB_SHELL_VERSION = __WEB_SHELL_VERSION__;
const MODES_CYCLE = DAEMON_APPROVAL_MODES;
const MAX_DISPLAYED_QUEUED_PROMPTS = 3;

interface QueuedPrompt {
  id: number;
  text: string;
  images?: PromptImage[];
}

export interface WebShellProps {
  /**
   * Daemon API base URL. When omitted, the standalone app reads the `daemon`
   * query parameter and otherwise uses same-origin API paths.
   */
  baseUrl?: string;
  /** Bearer token for daemon API calls. Standalone mode falls back to `?token=`. */
  token?: string;
  /** Existing daemon session to attach to. Standalone mode falls back to `/session/:id`. */
  initialSessionId?: string;
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
}

function getSessionIdFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const match = window.location.pathname.match(/\/session\/([^/]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
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
  baseUrl,
  token,
  initialSessionId: providedInitialSessionId,
  onSessionIdChange,
  theme: providedTheme = 'dark',
  onThemeChange,
  language: providedLanguage,
  onLanguageChange,
}: WebShellProps = {}) {
  const initialSessionId = useMemo(
    () => providedInitialSessionId ?? getSessionIdFromUrl(),
    [providedInitialSessionId],
  );
  const [selectedLanguage, setSelectedLanguage] = useState<WebShellLanguage>(
    () =>
      providedLanguage === undefined
        ? getInitialLanguage()
        : normalizeLanguage(providedLanguage),
  );
  const t = useMemo(() => getTranslator(selectedLanguage), [selectedLanguage]);
  const { store, state, connection, actions, promptStatus } = useDaemonSession({
    baseUrl: baseUrl ?? DAEMON_BASE_URL,
    token: token ?? DAEMON_TOKEN,
    initialSessionId,
    loadWarnings: {
      models: t('loadWarning.models'),
      commands: t('loadWarning.commands'),
      context: t('loadWarning.context'),
    },
  });

  const messageBlocks = useAnimationFrameValue(state.blocks);
  const messages = useMemo(
    () => transcriptBlocksToMessages(messageBlocks),
    [messageBlocks],
  );
  const pendingApproval = useMemo(
    () => extractPendingPermission(messageBlocks),
    [messageBlocks],
  );
  const shouldHideComposer = pendingApproval !== null;
  const floatingTodos = useMemo(() => getFloatingTodos(messages), [messages]);
  const transcriptStreamingState = useMemo(
    () => extractStreamingState(messageBlocks),
    [messageBlocks],
  );
  const streamingState = useMemo<StreamingState>(() => {
    if (promptStatus === 'idle') {
      return transcriptStreamingState;
    }
    if (transcriptStreamingState !== 'idle') {
      return transcriptStreamingState;
    }
    return promptStatus === 'waiting' ? 'waiting' : 'responding';
  }, [promptStatus, transcriptStreamingState]);
  const streamingStateRef = useRef<StreamingState>(streamingState);
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
      actions
        .setApprovalMode(modeId)
        .then((result) => {
          setCurrentMode(result.mode || modeId);
        })
        .catch((error: unknown) => {
          reportError(error, t('local.approvalMode'));
        });
    },
    [actions, reportError, t],
  );

  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

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
                actions
                  .sendPrompt(`/language ui ${nextLanguage}`, undefined, {
                    optimisticUserMessage: false,
                  })
                  .then(() => actions.refreshCommands())
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
              actions
                .sendPrompt(text, images)
                .catch((error: unknown) =>
                  reportError(error, 'Failed to send /model --fast'),
                );
              return true;
            }
            if (modelArg) {
              actions
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
            actions
              .setApprovalMode('plan')
              .then(() => {
                setCurrentMode('plan');
                if (prompt) {
                  actions
                    .sendPrompt(prompt, images)
                    .catch((error: unknown) =>
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
              actions
                .sendPrompt(text, images)
                .catch((error: unknown) =>
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
            actions.newSession().catch((error: unknown) => {
              reportError(error, 'Failed to create a new session');
            });
            return true;
          }
          if (cmd === 'rename') {
            const renameArg = parseRenameArgument(text.slice(match[0].length));
            if (renameArg.type === 'auto' || renameArg.type === 'delegate') {
              if (promptBlocked) return enqueuePrompt(text, images);
              actions
                .sendPrompt(text, images)
                .catch((error: unknown) =>
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
            actions
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
              actions.loadSession(sessionId).catch((error: unknown) => {
                reportError(error, 'Failed to load session');
              });
            } else {
              setShowResumeDialog(true);
            }
            return true;
          }
        }
        // Forward slash commands as prompts
        if (promptBlocked) return enqueuePrompt(text, images);
        actions
          .sendPrompt(text, images)
          .catch((error: unknown) =>
            reportError(error, 'Failed to send command'),
          );
        return true;
      } else if (text.startsWith('!')) {
        if (promptBlocked) return enqueuePrompt(text, images);
        const cmd = text.slice(1).trim();
        if (!cmd) return false;
        actions
          .sendPrompt(formatShellCommandPrompt(cmd))
          .catch((error: unknown) => {
            reportError(error, 'Failed to send shell command');
          });
        return true;
      } else {
        if (promptBlocked) return enqueuePrompt(text, images);
        actions
          .sendPrompt(text, images)
          .catch((error: unknown) =>
            reportError(error, 'Failed to send message'),
          );
        return true;
      }
    },
    [
      actions,
      store,
      enqueuePrompt,
      handleThemeChange,
      handleSetMode,
      messages,
      onLanguageChange,
      reportError,
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
      actions
        .respondToPermission(id, selectedOption, answers)
        .catch((error: unknown) => {
          reportError(error, 'Failed to submit permission choice');
        });
    },
    [actions, reportError],
  );

  const handleCancel = useCallback(() => {
    actions.cancel().catch((error: unknown) => {
      reportError(error, 'Failed to cancel request');
    });
  }, [actions, reportError]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
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
    pendingApproval,
    dialogOpen,
    clearQueuedPrompts,
  ]);

  const isDisabled = !connected;

  const handleModelSelect = useCallback(
    (modelId: string) => {
      actions
        .setModel(modelId)
        .then(() => {
          setCurrentModel(modelId);
        })
        .catch((error: unknown) => {
          reportError(error, t('model.switch'));
        });
    },
    [actions, reportError, t],
  );

  const handleFastModelSelect = useCallback(
    (modelId: string) => {
      if (streamingState !== 'idle') return;
      actions.sendPrompt(`/model --fast ${modelId}`).catch((error: unknown) => {
        reportError(error, 'Failed to switch fast model');
      });
    },
    [actions, streamingState, reportError],
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

  const appClassName = `${styles.app} ${
    selectedTheme === 'light' ? styles.themeLight : styles.themeDark
  }`;

  return (
    <I18nProvider language={selectedLanguage}>
      <div className={appClassName}>
        {modelDialogMode ? (
          <ModelDialog
            mode={modelDialogMode}
            currentModel={currentModel}
            availableModels={connection.models ?? []}
            onSelect={
              modelDialogMode === 'fast'
                ? handleFastModelSelect
                : handleModelSelect
            }
            onClose={() => setModelDialogMode(null)}
          />
        ) : showResumeDialog ? (
          <ResumeDialog
            currentSessionId={connection.sessionId}
            loadSessions={actions.listSessions}
            onSelect={(sessionId) => {
              actions.loadSession(sessionId).catch((error: unknown) => {
                reportError(error, 'Failed to load session');
              });
            }}
            onClose={() => setShowResumeDialog(false)}
          />
        ) : showReleaseDialog ? (
          <ReleaseSessionDialog
            currentSessionId={connection.sessionId}
            loadSessions={actions.listSessions}
            releaseSession={actions.releaseSession}
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
        ) : showModeDialog ? (
          <ApprovalModeDialog
            currentMode={currentMode}
            onSelect={handleSetMode}
            onClose={() => setShowModeDialog(false)}
          />
        ) : showMcpDialog ? (
          <McpDialog
            loadStatus={actions.loadMcpStatus}
            loadTools={actions.loadMcpTools}
            restartServer={actions.restartMcpServer}
            onClose={() => setShowMcpDialog(false)}
          />
        ) : showHelpDialog ? (
          <HelpDialog
            commands={commands}
            onClose={() => setShowHelpDialog(false)}
          />
        ) : showThemeDialog ? (
          <ThemeDialog
            currentTheme={selectedTheme}
            onSelect={handleThemeChange}
            onClose={() => setShowThemeDialog(false)}
          />
        ) : showSkillsDialog ? (
          <SkillsDialog
            loadStatus={actions.loadSkillsStatus}
            onClose={() => setShowSkillsDialog(false)}
          />
        ) : showToolsDialog ? (
          <ToolsDialog
            loadStatus={actions.loadToolsStatus}
            setToolEnabled={actions.setWorkspaceToolEnabled}
            onClose={() => setShowToolsDialog(false)}
          />
        ) : memoryDialogMode ? (
          <MemoryDialog
            initialMode={memoryDialogMode}
            loadStatus={actions.loadMemoryStatus}
            readFile={actions.readWorkspaceFile}
            writeMemory={actions.writeMemory}
            onMessage={(text, type = 'status') => {
              store.dispatch([{ type, text }]);
            }}
            onClose={() => setMemoryDialogMode(null)}
          />
        ) : agentsDialogMode ? (
          <AgentsDialog
            initialMode={agentsDialogMode}
            listAgents={actions.listAgents}
            getAgent={actions.getAgent}
            createAgent={actions.createAgent}
            deleteAgent={actions.deleteAgent}
            onClose={() => setAgentsDialogMode(null)}
          />
        ) : (
          <>
            <div
              className={
                messages.length > 0 || streamingState !== 'idle'
                  ? `${styles.content} ${styles.contentHasMessages}`
                  : styles.content
              }
            >
              <MessageList
                messages={messages}
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

              <StreamingStatus
                streamingState={streamingState}
                tokenCount={connection.tokenCount ?? 0}
              />
            </div>

            <div className={styles.footer}>
              {floatingTodos.length > 0 && <TodoPanel todos={floatingTodos} />}
              {!shouldHideComposer && (
                <div className={styles.composer}>
                  <QueuedPromptDisplay prompts={queuedPrompts} t={t} />
                  <Editor
                    onSubmit={handleSubmit}
                    onCycleMode={handleCycleMode}
                    onToggleShortcuts={handleToggleShortcuts}
                    disabled={isDisabled}
                    commands={commands}
                    skills={connection.skills ?? []}
                    daemonBaseUrl={DAEMON_BASE_URL}
                    daemonToken={token ?? DAEMON_TOKEN}
                    queuedMessages={queuedPrompts.map((prompt) => prompt.text)}
                    onPopQueuedMessages={popQueuedPromptsForEdit}
                    onClearQueuedMessages={clearQueuedPrompts}
                    currentMode={currentMode}
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
                (showShortcuts ? (
                  <ShortcutsPanel />
                ) : (
                  <StatusBar
                    connected={connected}
                    streamingState={streamingState}
                    currentModel={currentModel}
                    currentMode={currentMode}
                    tokenCount={connection.tokenCount ?? 0}
                    contextWindow={connection.contextWindow ?? 0}
                  />
                ))}
            </div>
          </>
        )}
      </div>
    </I18nProvider>
  );
}

function formatShellCommandPrompt(cmd: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(cmd.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `Run the following shell command exactly, do not modify it:\n${fence}sh\n${cmd}\n${fence}`;
}

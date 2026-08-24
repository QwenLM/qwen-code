import '../styles/globals.css';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import {
  CircleUserRoundIcon,
  EyeIcon,
  EyeOffIcon,
  FileTextIcon,
  HistoryIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import type {
  DaemonInputAnnotation,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  CompactModeContext,
  TodoDetailContext,
  TodoTimelineContext,
} from '../App';
import type { CommandInfo, PermissionRequest } from '../adapters/types';
import type { PromptFile, PromptImage } from '../adapters/promptTypes';
import type { SkillInfo } from '../completions/slashCompletion';
import {
  WebShellCustomizationProvider,
  type WebShellAtProvider,
  type WebShellComposerInput,
} from '../customization';
import { transcriptBlocksToLocalizedMessages } from '../hooks/useMessages';
import {
  getTranslator,
  I18nProvider,
  normalizeLanguage,
  type WebShellLanguage,
} from '../i18n';
import { McpAppHostContext } from '../mcpAppHostContext';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  ThemeProvider,
  WebShellThemeId,
  type WebShellTheme,
} from '../themeContext';
import { TranscriptRenderModeProvider } from '../transcriptRenderMode';
import { computeTodoDetails, computeTodoTimeline } from '../utils/todos';
import appStyles from '../App.module.css';
import { AskUserQuestion } from './messages/AskUserQuestion';
import { ToolApproval } from './messages/ToolApproval';
import { ChatEditor } from './ChatEditor';
import { ErrorBoundary } from './ErrorBoundary';
import { MessageList } from './MessageList';
import { RootErrorFallback } from './RootErrorFallback';
import { WelcomeHeader } from './WelcomeHeader';
import styles from './EmbeddedWebShell.module.css';

export type EmbeddedWebShellPermissionRequest = PermissionRequest;

export interface EmbeddedWebShellSession {
  id: string;
  title: string;
  updatedAt?: string | number;
  messageCount?: number;
}

export interface EmbeddedWebShellActiveFile {
  name: string;
  path: string;
  startLine?: number;
  endLine?: number;
  included: boolean;
}

export interface EmbeddedWebShellNotice {
  id: string;
  message: string;
  tone?: 'info' | 'error';
  actionLabel?: string;
}

export interface EmbeddedWebShellSubmit {
  text: string;
  images?: PromptImage[];
  files?: PromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
}

export interface EmbeddedWebShellProps {
  blocks: readonly DaemonTranscriptBlock[];
  theme?: WebShellTheme;
  language?: 'en' | 'zh-CN' | 'zh' | 'zh-cn';
  className?: string;
  style?: CSSProperties;
  workspaceCwd?: string;
  loading?: boolean;
  loadingLabel?: string;
  authenticated?: boolean | null;
  sessionId?: string;
  sessionTitle?: string;
  sessions?: readonly EmbeddedWebShellSession[];
  historyOpen?: boolean;
  historySearch?: string;
  historyLoading?: boolean;
  historyHasMore?: boolean;
  isResponding?: boolean;
  isPreparing?: boolean;
  commands?: readonly CommandInfo[];
  skills?: readonly SkillInfo[];
  availableModels?: readonly { id: string; label?: string }[];
  currentModel?: string;
  currentMode?: string;
  tokenCount?: number;
  contextWindow?: number;
  composerInput?: WebShellComposerInput;
  composerInputVersion?: number;
  onComposerTextChange?: (text: string) => void;
  atProviders?: readonly WebShellAtProvider[];
  activeFile?: EmbeddedWebShellActiveFile | null;
  pendingPermission?: EmbeddedWebShellPermissionRequest | null;
  pendingQuestion?: EmbeddedWebShellPermissionRequest | null;
  notices?: readonly EmbeddedWebShellNotice[];
  editingMessage?: { content: string } | null;
  onSubmit: (submission: EmbeddedWebShellSubmit) => boolean | void;
  onCancel?: () => void;
  onAuthenticate?: () => void;
  onOpenAccount?: () => void;
  onNewSession?: () => void;
  onHistoryOpenChange?: (open: boolean) => void;
  onHistorySearchChange?: (query: string) => void;
  onSessionSelect?: (sessionId: string) => void;
  onLoadMoreSessions?: () => void;
  onSelectModel?: (modelId: string) => void;
  onSelectMode?: (modeId: string) => void;
  onShowContextUsage?: () => void;
  onAttachFile?: () => void;
  onFocusActiveFile?: () => void;
  onActiveFileIncludedChange?: (included: boolean) => void;
  onEditUserMessage?: (targetTurnIndex: number, content: string) => void;
  onCancelEdit?: () => void;
  onPermissionResponse?: (requestId: string, optionId: string) => void;
  onQuestionResponse?: (
    requestId: string,
    optionId: string,
    answers?: Record<string, string>,
  ) => Promise<boolean> | boolean;
  onNoticeAction?: (noticeId: string) => void;
  onError?: (error: unknown) => void;
  onLinkClick?: (href: string, anchorText: string) => boolean | void;
}

const DEFAULT_CHAT_WIDTH = 1000;
const CHAT_SHELL_PADDING = 40;

function resolveLanguage(
  language: EmbeddedWebShellProps['language'],
): WebShellLanguage {
  if (language !== undefined) return normalizeLanguage(language);
  if (typeof navigator === 'undefined') return 'en';
  return normalizeLanguage(navigator.language);
}

function formatSessionMeta(session: EmbeddedWebShellSession): string {
  if (session.messageCount !== undefined) {
    return String(session.messageCount);
  }
  if (session.updatedAt === undefined) return '';
  const date = new Date(session.updatedAt);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export function EmbeddedWebShell(props: EmbeddedWebShellProps): ReactElement {
  const {
    blocks,
    theme = WebShellThemeId.Dark,
    className,
    style,
    workspaceCwd = '',
    loading = false,
    loadingLabel = 'Preparing Qwen Code...',
    authenticated = true,
    sessionId,
    sessionTitle = 'Qwen Code',
    sessions = [],
    historyOpen = false,
    historySearch = '',
    historyLoading = false,
    historyHasMore = false,
    isResponding = false,
    isPreparing = false,
    commands = [],
    skills = [],
    availableModels = [],
    currentModel = '',
    currentMode = 'default',
    tokenCount = 0,
    contextWindow = 0,
    composerInput,
    composerInputVersion,
    onComposerTextChange,
    atProviders,
    activeFile,
    pendingPermission,
    pendingQuestion,
    notices = [],
    editingMessage,
    onSubmit,
    onCancel,
    onAuthenticate,
    onOpenAccount,
    onNewSession,
    onHistoryOpenChange,
    onHistorySearchChange,
    onSessionSelect,
    onLoadMoreSessions,
    onSelectModel,
    onSelectMode,
    onShowContextUsage,
    onAttachFile,
    onFocusActiveFile,
    onActiveFileIncludedChange,
    onEditUserMessage,
    onCancelEdit,
    onPermissionResponse,
    onQuestionResponse,
    onNoticeAction,
    onError,
    onLinkClick,
  } = props;
  const language = resolveLanguage(props.language);
  const t = useMemo(() => getTranslator(language), [language]);
  const messages = useMemo(
    () => transcriptBlocksToLocalizedMessages(blocks, t),
    [blocks, t],
  );
  const todoDetails = useMemo(() => computeTodoDetails(messages), [messages]);
  const todoTimeline = useMemo(() => computeTodoTimeline(messages), [messages]);
  const rootRef = useRef<HTMLDivElement>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const portalVariableNamesRef = useRef<Set<string>>(new Set());
  const hasConversation = blocks.length > 0 || isResponding;
  const approvalOpen = Boolean(pendingPermission || pendingQuestion);
  const renderComposerToolbarStart = useMemo(() => {
    if (!activeFile && !onAttachFile) return undefined;
    return function EmbeddedComposerToolbarStart({
      disabled,
    }: {
      disabled: boolean;
    }) {
      const selection = activeFile?.startLine
        ? activeFile.endLine && activeFile.endLine !== activeFile.startLine
          ? `:${activeFile.startLine}-${activeFile.endLine}`
          : `:${activeFile.startLine}`
        : '';
      return (
        <div className={styles.hostToolbar}>
          {onAttachFile && (
            <button
              type="button"
              className={styles.hostToolbarButton}
              aria-label="Attach file"
              title="Attach file"
              disabled={disabled}
              onClick={onAttachFile}
            >
              <PaperclipIcon />
            </button>
          )}
          {activeFile && (
            <div className={styles.activeFileChip}>
              <button
                type="button"
                className={styles.activeFileName}
                title={activeFile.path}
                disabled={disabled}
                onClick={onFocusActiveFile}
              >
                <FileTextIcon />
                <span>{`${activeFile.name}${selection}`}</span>
              </button>
              {onActiveFileIncludedChange && (
                <button
                  type="button"
                  className={styles.activeFileToggle}
                  aria-label={
                    activeFile.included
                      ? 'Exclude active editor context'
                      : 'Include active editor context'
                  }
                  aria-pressed={activeFile.included}
                  title={
                    activeFile.included
                      ? 'Active editor context included'
                      : 'Active editor context excluded'
                  }
                  disabled={disabled}
                  onClick={() =>
                    onActiveFileIncludedChange(!activeFile.included)
                  }
                >
                  {activeFile.included ? <EyeIcon /> : <EyeOffIcon />}
                </button>
              )}
            </div>
          )}
        </div>
      );
    };
  }, [activeFile, onActiveFileIncludedChange, onAttachFile, onFocusActiveFile]);
  const widthStyle = {
    '--chat-regular-content-width': `${DEFAULT_CHAT_WIDTH}px`,
    '--chat-regular-shell-width': `${DEFAULT_CHAT_WIDTH + CHAT_SHELL_PADDING}px`,
    '--chat-content-width': `${DEFAULT_CHAT_WIDTH}px`,
    '--chat-shell-width': `${DEFAULT_CHAT_WIDTH + CHAT_SHELL_PADDING}px`,
  } as CSSProperties;
  const rootClassName = [
    appStyles.app,
    appStyles.appChat,
    theme === WebShellThemeId.Light
      ? appStyles.themeLight
      : appStyles.themeDark,
    theme === WebShellThemeId.Dark ? 'dark' : undefined,
    styles.root,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  useLayoutEffect(() => {
    if (typeof document === 'undefined') return;
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
    const root = rootRef.current;
    if (!root || !portalRoot) return;
    const computedStyle = getComputedStyle(root);
    const nextNames = new Set<string>();
    portalRoot.classList.toggle('dark', theme === WebShellThemeId.Dark);
    portalRoot.lang = language;
    for (let index = 0; index < computedStyle.length; index += 1) {
      const name = computedStyle[index];
      if (!name.startsWith('--')) continue;
      nextNames.add(name);
      portalRoot.style.setProperty(name, computedStyle.getPropertyValue(name));
    }
    for (const name of portalVariableNamesRef.current) {
      if (!nextNames.has(name)) portalRoot.style.removeProperty(name);
    }
    portalVariableNamesRef.current = nextNames;
  }, [language, portalRoot, rootClassName, style, theme]);

  const handleSubmit = useCallback(
    (
      text: string,
      images?: PromptImage[],
      files?: PromptFile[],
      commitAccepted?: () => void,
      metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
    ) => {
      const accepted = onSubmit({
        text,
        images,
        files,
        inputAnnotations: metadata?.inputAnnotations,
      });
      if (accepted !== false) commitAccepted?.();
      return accepted;
    },
    [onSubmit],
  );

  const handleQuestionResponse = useCallback(
    async (
      requestId: string,
      optionId: string,
      answers?: Record<string, string>,
    ) => {
      if (!onQuestionResponse) return false;
      return await onQuestionResponse(requestId, optionId, answers);
    },
    [onQuestionResponse],
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a');
      if (!(anchor instanceof HTMLAnchorElement) || !onLinkClick) return;
      if (onLinkClick(anchor.href, anchor.textContent ?? '') !== false) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [onLinkClick],
  );

  const content = (
    <div
      ref={rootRef}
      className={rootClassName}
      style={{ ...widthStyle, ...style }}
      data-web-shell-root
      data-web-shell-shadcn
      data-web-shell-embedded-host
      lang={language}
    >
      <header className={styles.header}>
        <div className={styles.title} title={sessionTitle}>
          {sessionTitle}
        </div>
        {onOpenAccount && (
          <button
            type="button"
            className={styles.headerAction}
            aria-label="Account"
            onClick={onOpenAccount}
          >
            <CircleUserRoundIcon />
          </button>
        )}
        {onHistoryOpenChange && (
          <button
            type="button"
            className={styles.headerAction}
            aria-label="History"
            aria-expanded={historyOpen}
            onClick={() => onHistoryOpenChange(true)}
          >
            <HistoryIcon />
          </button>
        )}
        {onNewSession && (
          <button
            type="button"
            className={styles.headerAction}
            aria-label="New session"
            onClick={onNewSession}
          >
            <PlusIcon />
          </button>
        )}
      </header>

      <div className={styles.body} onClick={handleClick}>
        {authenticated === false ? (
          <div className={styles.empty} data-testid="embedded-auth-empty">
            <WelcomeHeader
              version=""
              cwd={workspaceCwd}
              currentModel={currentModel}
              currentMode={currentMode}
              hideTips
            />
            <div className={styles.emptyText}>
              Sign in to start a Qwen Code session in this workspace.
            </div>
            {onAuthenticate && (
              <button
                type="button"
                className={styles.primaryAction}
                onClick={onAuthenticate}
              >
                Sign in
              </button>
            )}
          </div>
        ) : !hasConversation ? (
          <div className={styles.empty} data-testid="embedded-chat-empty">
            <WelcomeHeader
              version=""
              cwd={workspaceCwd}
              currentModel={currentModel}
              currentMode={currentMode}
            />
          </div>
        ) : (
          <div
            className={`${appStyles.content} ${appStyles.contentHasMessages}`}
          >
            <MessageList
              messages={messages}
              pendingApproval={pendingPermission ?? null}
              isResponding={isResponding}
              workspaceCwd={workspaceCwd}
              onEditUserMessage={onEditUserMessage}
            />
          </div>
        )}

        {notices.length > 0 && (
          <div className={styles.notices} data-testid="embedded-notices">
            {notices.map((notice) => (
              <div
                key={notice.id}
                className={`${styles.notice} ${notice.tone === 'error' ? styles.noticeError : ''}`}
                role={notice.tone === 'error' ? 'alert' : 'status'}
              >
                <span>{notice.message}</span>
                {notice.actionLabel && onNoticeAction && (
                  <button
                    type="button"
                    className={styles.noticeAction}
                    onClick={() => onNoticeAction(notice.id)}
                  >
                    {notice.actionLabel}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {authenticated && (
          <div className={styles.footer}>
            {pendingPermission && (
              <div className={appStyles.approvalOverlay}>
                <ToolApproval
                  request={pendingPermission}
                  variant="floating"
                  onConfirm={(requestId, optionId) =>
                    onPermissionResponse?.(requestId, optionId)
                  }
                />
              </div>
            )}
            {pendingQuestion && (
              <div className={appStyles.approvalOverlay}>
                <AskUserQuestion
                  request={pendingQuestion}
                  variant="floating"
                  onConfirm={handleQuestionResponse}
                  onError={(error) => onError?.(error)}
                />
              </div>
            )}
            {editingMessage && (
              <div className={styles.editingBar} role="status">
                <span>Editing message</span>
                <button
                  type="button"
                  className={styles.editingCancel}
                  onClick={onCancelEdit}
                  aria-label="Cancel editing"
                  title="Cancel editing"
                >
                  <XIcon aria-hidden="true" />
                </button>
              </div>
            )}
            <div
              className={approvalOpen ? appStyles.composerHidden : undefined}
            >
              <ChatEditor
                onSubmit={handleSubmit}
                onInputTextChange={onComposerTextChange}
                onCancel={onCancel}
                isRunning={isResponding}
                isPreparing={isPreparing}
                disabled={loading || authenticated !== true}
                commands={[...commands]}
                skills={[...skills]}
                currentMode={currentMode}
                currentModel={currentModel}
                availableModels={[...availableModels]}
                onSelectMode={onSelectMode}
                onSelectModel={onSelectModel}
                tokenCount={tokenCount}
                contextWindow={contextWindow}
                onShowContextUsage={onShowContextUsage}
                visibleToolbarActions={[
                  'approvalMode',
                  'contextUsage',
                  'model',
                  'commands',
                  'files',
                ]}
                builtinAtProviders={false}
                atProviders={atProviders}
                sessionId={sessionId}
                sessionName={sessionTitle}
                composerInput={composerInput}
                composerInputVersion={composerInputVersion}
                dialogOpen={approvalOpen || historyOpen}
              />
            </div>
          </div>
        )}

        {loading && (
          <div className={styles.loading} role="status">
            <div className={styles.loadingContent}>
              <LoaderCircleIcon className="animate-spin" />
              <span>{loadingLabel}</span>
            </div>
          </div>
        )}

        {historyOpen && onHistoryOpenChange && (
          <div
            className={styles.historyBackdrop}
            role="presentation"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) {
                onHistoryOpenChange(false);
              }
            }}
          >
            <section className={styles.history} aria-label="Session history">
              <div className={styles.historyHeader}>
                <input
                  className={styles.historySearch}
                  value={historySearch}
                  placeholder="Search sessions"
                  aria-label="Search sessions"
                  onChange={(event) =>
                    onHistorySearchChange?.(event.currentTarget.value)
                  }
                />
                <button
                  type="button"
                  className={styles.headerAction}
                  aria-label="Close history"
                  onClick={() => onHistoryOpenChange(false)}
                >
                  <XIcon />
                </button>
              </div>
              <div className={styles.historyList}>
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={`${styles.sessionRow} ${session.id === sessionId ? styles.sessionRowActive : ''}`}
                    onClick={() => {
                      onSessionSelect?.(session.id);
                      onHistoryOpenChange(false);
                    }}
                  >
                    <span className={styles.sessionTitle}>{session.title}</span>
                    <span className={styles.sessionMeta}>
                      {formatSessionMeta(session)}
                    </span>
                  </button>
                ))}
                {historyHasMore && (
                  <button
                    type="button"
                    className={`${styles.primaryAction} ${styles.loadMore}`}
                    disabled={historyLoading}
                    onClick={onLoadMoreSessions}
                  >
                    {historyLoading ? 'Loading…' : 'Load more'}
                  </button>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <ErrorBoundary
      label="web-shell-embedded-root"
      resetKeys={[sessionId, language]}
      fallback={(error, reset) => (
        <RootErrorFallback error={error} onRetry={reset} language={language} />
      )}
    >
      <ThemeProvider value={theme}>
        <I18nProvider language={language}>
          <McpAppHostContext.Provider value={undefined}>
            <WebShellPortalRootContext.Provider value={portalRoot}>
              <TranscriptRenderModeProvider value="interactive">
                <WebShellCustomizationProvider
                  value={{
                    collapseCompletedTurns: false,
                    renderComposerToolbarStart,
                  }}
                >
                  <TodoTimelineContext.Provider value={todoTimeline}>
                    <TodoDetailContext.Provider value={todoDetails}>
                      <CompactModeContext.Provider value={true}>
                        {content}
                      </CompactModeContext.Provider>
                    </TodoDetailContext.Provider>
                  </TodoTimelineContext.Provider>
                </WebShellCustomizationProvider>
              </TranscriptRenderModeProvider>
            </WebShellPortalRootContext.Provider>
          </McpAppHostContext.Provider>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

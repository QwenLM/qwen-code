/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  WebShellWithProviders,
  type ComposerToolbarAction,
  type TurnOutputOpenRequest,
  type WebShellApi,
  type WebShellComposerApi,
  type WebShellTheme,
} from '@qwen-code/web-shell';
import {
  DaemonClient,
  type DaemonSessionSummary,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { ChevronDown, FileText, LoaderCircle, Plus, X } from 'lucide-react';
import { useVSCode } from './hooks/useVSCode.js';
import { QwenOnboarding } from './components/QwenOnboarding.js';
import { SessionHistoryDropdown } from './components/SessionHistoryDropdown.js';
import {
  createChromeStrings,
  readLanguage,
  type ChromeStrings,
} from './strings.js';
import { VSCODE_SESSION_SOURCE_TYPE } from './sessionSource.js';
import {
  findBlockByRowKey,
  findLastAssistantText,
  formatBlocksForCopyAll,
  getBlockCopyText,
} from './utils/copyTranscript.js';
import { resolveFileLinkFromAnchor } from './utils/fileLinks.js';

const SESSION_SWITCH_TIMEOUT_MS = 15_000;

const COMPOSER_TOOLBAR_ACTIONS = [
  'approvalMode',
  'contextUsage',
  'model',
  'voice',
] as const satisfies readonly ComposerToolbarAction[];

/** Host-only slash entries. Built per language so the menu is not half-English. */
function buildVsCodeSlashCommands(t: ChromeStrings) {
  return [
    {
      name: 'model',
      description: t('cmd.model.description'),
      completionLabel: t('cmd.model.label'),
      completionSection: t('cmd.section.model'),
      completionPriority: -110,
      autoSubmit: true,
    },
    {
      name: 'auth',
      description: t('cmd.auth.description'),
      completionSection: t('cmd.section.account'),
      completionPriority: -100,
      autoSubmit: true,
    },
    {
      name: 'account',
      description: t('cmd.account.description'),
      completionLabel: t('cmd.account.label'),
      completionSection: t('cmd.section.account'),
      completionPriority: -100,
      autoSubmit: true,
    },
    {
      name: 'export',
      description: t('cmd.export.description'),
      completionSection: t('cmd.section.session'),
      completionPriority: -90,
      subcommands: ['html', 'md', 'json', 'jsonl'],
    },
  ];
}

const VSCODE_HIDDEN_SLASH_COMMANDS = [
  'theme',
  'language',
  'settings',
  'release',
  'schedule',
  'extensions',
  'workspace',
  'fork',
  'branch',
  'diff',
  'log',
  'prs',
  'new',
  'clear',
  'reset',
  'rename',
  'resume',
  'agents',
  'tasks',
] as const;

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
};

const VSCODE_THEME_STYLE = {
  '--font-sans':
    'var(--vscode-chat-font-family, var(--vscode-font-family, system-ui, sans-serif))',
  '--font-mono':
    'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, monospace)',
  '--background': 'var(--vscode-sideBar-background)',
  '--foreground': 'var(--vscode-foreground)',
  '--card': 'var(--vscode-editorWidget-background)',
  '--card-foreground': 'var(--vscode-editorWidget-foreground)',
  '--popover': 'var(--vscode-dropdown-background)',
  '--popover-foreground': 'var(--vscode-dropdown-foreground)',
  '--primary': 'var(--vscode-button-background)',
  '--primary-foreground': 'var(--vscode-button-foreground)',
  '--secondary': 'var(--vscode-input-background)',
  '--secondary-foreground': 'var(--vscode-descriptionForeground)',
  '--muted': 'var(--vscode-sideBarSectionHeader-background)',
  '--muted-foreground': 'var(--vscode-descriptionForeground)',
  '--accent': 'var(--vscode-list-hoverBackground)',
  '--accent-foreground': 'var(--vscode-list-hoverForeground)',
  '--border': 'var(--vscode-widget-border, var(--vscode-panel-border))',
  '--ring': 'var(--vscode-focusBorder)',
  '--destructive': 'var(--vscode-errorForeground)',
  '--error-border': 'var(--vscode-inputValidation-errorBorder)',
  '--chat-editor-bg-primary': 'var(--vscode-input-background)',
  '--chat-editor-bg-tertiary': 'var(--vscode-toolbar-hoverBackground)',
  '--chat-editor-border-color':
    'var(--vscode-input-border, var(--vscode-widget-border))',
  '--chat-editor-text-primary': 'var(--vscode-input-foreground)',
  '--chat-editor-text-secondary': 'var(--vscode-descriptionForeground)',
  '--chat-editor-text-dimmed': 'var(--vscode-input-placeholderForeground)',
  '--chat-editor-accent-color': 'var(--vscode-focusBorder)',
  '--agent-gray-200': 'var(--vscode-input-border, var(--vscode-widget-border))',
  '--agent-gray-500': 'var(--vscode-descriptionForeground)',
  '--success-color': 'var(--vscode-testing-iconPassed, #89d185)',
  '--warning-color': 'var(--vscode-editorWarning-foreground, #cca700)',
  '--error-color': 'var(--vscode-errorForeground, #f48771)',
  '--scrollbar-thumb': 'var(--vscode-scrollbarSlider-background)',
  '--scrollbar-thumb-hover': 'var(--vscode-scrollbarSlider-hoverBackground)',
  '--scrollbar-track': 'transparent',
} as CSSProperties;

const SHELL_STYLE: CSSProperties = {
  ...ROOT_STYLE,
  ...VSCODE_THEME_STYLE,
  height: '100%',
};

const VSCODE_EMBEDDED_CSS = `
  @keyframes qwen-vscode-spin { to { transform: rotate(360deg); } }
  .qwen-vscode-header-button:hover,
  .qwen-vscode-header-button:focus-visible,
  .qwen-vscode-toolbar-button:hover,
  .qwen-vscode-toolbar-button:focus-visible {
    background: var(--vscode-toolbar-hoverBackground);
    outline: none;
  }
  .qwen-vscode-toolbar-start {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 2px;
  }
  .qwen-vscode-active-file-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 380px) {
    .qwen-vscode-active-file {
      width: 28px !important;
      max-width: 28px !important;
      padding: 0 6px !important;
    }
    .qwen-vscode-active-file-label { display: none; }
  }
`;

function readTheme(): WebShellTheme {
  const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
  return /light/i.test(kind) ? 'light' : 'dark';
}

interface RuntimeConfig {
  baseUrl: string;
  token?: string;
  clientId?: string;
  workspaceCwd?: string;
  sessionId?: string;
  hostKind?: 'view' | 'panel';
}

function readRuntimeConfig(): RuntimeConfig | null {
  const baseUrl = document.body.dataset.qwenDaemonBaseUrl;
  if (!baseUrl) return null;
  return {
    baseUrl,
    token: document.body.dataset.qwenDaemonToken || undefined,
    clientId: document.body.dataset.qwenDaemonClientId || undefined,
    workspaceCwd: document.body.dataset.qwenWorkspaceCwd || undefined,
    sessionId: document.body.dataset.qwenSessionId || undefined,
    hostKind:
      document.body.dataset.qwenHostKind === 'panel'
        ? 'panel'
        : document.body.dataset.qwenHostKind === 'view'
          ? 'view'
          : undefined,
  };
}

interface ActiveFileContext {
  fileName: string;
  filePath: string;
  selection?: { startLine: number; endLine: number };
}

interface HostNotice {
  tone: 'info' | 'error';
  text: string;
  action?: { label: string; path: string };
}

interface AccountInfo {
  authType?: string | null;
  baseUrl?: string | null;
  envKey?: string | null;
  modelId?: string | null;
  error?: string;
}

interface InsightProgress {
  stage: string;
  progress: number;
  detail?: string;
}

interface EditingMessage {
  turnIndex: number;
}

function isAutomaticApprovalMode(modeId: unknown): boolean {
  return modeId === 'auto-edit' || modeId === 'yolo';
}

interface PermissionDiffPreview {
  path: string;
  oldText: string;
  newText: string;
}

function permissionDiffPreview(
  block: Extract<DaemonTranscriptBlock, { kind: 'permission' }>,
): PermissionDiffPreview | undefined {
  // Trust the SDK's hardened matcher (createDaemonToolPreview): only an
  // authoritative file_diff preview may drive the native diff. Mining
  // model-controlled toolCall args here diverged from the daemon's
  // classification and could present unapproved arguments as the proposed
  // edit on the very surface the user approves or denies on.
  if (block.preview.kind !== 'file_diff') {
    return undefined;
  }
  const { path, oldText, newText } = block.preview;
  if (
    typeof path !== 'string' ||
    (oldText === undefined && newText === undefined)
  ) {
    return undefined;
  }
  // Write/create previews legitimately omit oldText; the diff editor opens
  // them against an empty old side.
  return { path, oldText: oldText ?? '', newText: newText ?? '' };
}

export function EmbeddedApp() {
  const vscode = useVSCode();
  const language = useMemo(readLanguage, []);
  const t = useMemo(() => createChromeStrings(language), [language]);
  const slashCommands = useMemo(() => buildVsCodeSlashCommands(t), [t]);
  const [theme, setTheme] = useState<WebShellTheme>(readTheme);
  const initialRuntime = useMemo(readRuntimeConfig, []);
  const [runtime, setRuntime] = useState(initialRuntime);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [runtimeError, setRuntimeError] = useState<string>();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authConnecting, setAuthConnecting] = useState(false);
  const [authError, setAuthError] = useState<string>();
  const [hostNotice, setHostNotice] = useState<HostNotice>();
  const [accountInfo, setAccountInfo] = useState<AccountInfo>();
  const [insightProgress, setInsightProgress] = useState<InsightProgress>();
  const [insightReportPath, setInsightReportPath] = useState<string>();
  const [activeFile, setActiveFile] = useState<ActiveFileContext>();
  const [includeActiveFile, setIncludeActiveFile] = useState(true);
  const [sessionTitle, setSessionTitle] = useState(() => t('session.new'));
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string>();
  const [sessionListLoading, setSessionListLoading] = useState(false);
  const [sessionListError, setSessionListError] = useState<string>();
  const [switchingSessionId, setSwitchingSessionId] = useState<string>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [editingMessage, setEditingMessage] = useState<EditingMessage>();
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<WebShellApi | null>(null);
  const composerRef = useRef<WebShellComposerApi | null>(null);
  const currentModelIdRef = useRef<string | undefined>(undefined);
  const transcriptBlocksRef = useRef<readonly DaemonTranscriptBlock[]>([]);
  const openPermissionDiffsRef = useRef(new Map<string, string>());
  const focusedPermissionRequestIdRef = useRef<string | undefined>(undefined);
  const contextMenuRowKeyRef = useRef<string | null>(null);
  const previousActiveFilePathRef = useRef<string | undefined>(undefined);
  const daemonBaseUrl = runtime?.baseUrl;
  const daemonToken = runtime?.token;
  const daemonClient = useMemo(
    () =>
      daemonBaseUrl
        ? new DaemonClient({ baseUrl: daemonBaseUrl, token: daemonToken })
        : null,
    [daemonBaseUrl, daemonToken],
  );

  const clearInsight = useCallback(() => {
    setInsightProgress(undefined);
    setInsightReportPath(undefined);
  }, []);

  const cancelMessageEditing = useCallback(() => {
    setEditingMessage(undefined);
    composerRef.current?.clear({ text: true, tags: true });
    composerRef.current?.focus?.();
  }, []);

  // Web Shell reports each distinct connection error value only once, so a
  // new identity here (e.g. when `t` is rebuilt on a language switch) re-runs
  // its notification effect without re-delivering a persisted error.
  const handleShellError = useCallback(
    (error: Error) => {
      clearInsight();
      setEditingMessage(undefined);
      setSwitchingSessionId(undefined);
      setCreatingSession(false);
      setHostNotice({
        tone: 'error',
        text: error.message || t('session.loadError'),
      });
    },
    [clearInsight, t],
  );

  // A retriable connection failure can leave a session switch pending
  // forever — neither settling into the exact session id nor erroring — and
  // the blocking overlay would lock the panel until a reload. Bound it the
  // way the pre-cutover host did.
  useEffect(() => {
    if (!switchingSessionId && !creatingSession) return;
    const timer = setTimeout(() => {
      setSwitchingSessionId(undefined);
      setCreatingSession(false);
      setHostNotice({ tone: 'error', text: t('session.switchTimeout') });
    }, SESSION_SWITCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [switchingSessionId, creatingSession, t]);

  const loadSessionHistory = useCallback(
    async (cursor?: string) => {
      if (!daemonClient || !runtime?.workspaceCwd || sessionListLoading) return;
      setSessionListLoading(true);
      setSessionListError(undefined);
      try {
        const page = await daemonClient
          .workspaceByCwd(runtime.workspaceCwd)
          .listWorkspaceSessionsPage({
            pageSize: 20,
            cursor,
            archiveState: 'active',
            // Only conversations started from VS Code. The daemon is shared
            // with the CLI and the browser Web Shell for this workspace, so an
            // unfiltered page lists sessions the user never opened here.
            sourceType: VSCODE_SESSION_SOURCE_TYPE,
          });
        const pageSessions = Array.isArray(page.sessions) ? page.sessions : [];
        setSessions((current) => {
          const merged = new Map(
            current.map((session) => [session.sessionId, session]),
          );
          for (const session of pageSessions) {
            merged.set(session.sessionId, session);
          }
          if (
            runtime.sessionId &&
            !merged.has(runtime.sessionId) &&
            runtime.workspaceCwd
          ) {
            merged.set(runtime.sessionId, {
              sessionId: runtime.sessionId,
              workspaceCwd: runtime.workspaceCwd,
              displayName: sessionTitle || undefined,
            });
          }
          return Array.from(merged.values());
        });
        setSessionCursor(page.nextCursor);
      } catch (error) {
        setSessionListError(
          error instanceof Error ? error.message : t('session.loadFailed'),
        );
      } finally {
        setSessionListLoading(false);
      }
    },
    [
      daemonClient,
      runtime?.sessionId,
      runtime?.workspaceCwd,
      sessionListLoading,
      sessionTitle,
      t,
    ],
  );

  const openSessionHistory = useCallback(() => {
    setSessionHistoryOpen(true);
    setSessionSearchQuery('');
    void loadSessionHistory();
  }, [loadSessionHistory]);

  const closeSessionHistory = useCallback(() => {
    setSessionHistoryOpen(false);
    historyButtonRef.current?.focus();
  }, []);

  const openReviewDiff = useCallback(
    (request: TurnOutputOpenRequest) => {
      if (request.kind !== 'review' || request.changes.length === 0) return;
      vscode.postMessage({
        type: 'openDiffList',
        data: {
          selectedPath: request.selectedPath,
          changes: request.changes.map((change) => ({
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            diffs: change.diffs,
          })),
        },
      });
    },
    [vscode],
  );

  const closeOpenPermissionDiffs = useCallback(() => {
    for (const path of openPermissionDiffsRef.current.values()) {
      vscode.postMessage({ type: 'closeDiff', data: { path } });
    }
    openPermissionDiffsRef.current.clear();
  }, [vscode]);

  const updateTranscript = useCallback(
    (blocks: readonly DaemonTranscriptBlock[]) => {
      transcriptBlocksRef.current = blocks;
      const pendingIds = new Set<string>();
      let permissionToFocus: string | undefined;
      for (const block of blocks) {
        if (block.kind !== 'permission' || block.resolved) {
          continue;
        }
        permissionToFocus = block.requestId;
        const diff = permissionDiffPreview(block);
        if (!diff) continue;
        const { path, oldText, newText } = diff;
        pendingIds.add(block.requestId);
        if (openPermissionDiffsRef.current.has(block.requestId)) continue;
        openPermissionDiffsRef.current.set(block.requestId, path);
        vscode.postMessage({
          type: 'openDiff',
          data: { path, oldText, newText, source: 'web-shell' },
        });
      }
      for (const [requestId, path] of openPermissionDiffsRef.current) {
        if (pendingIds.has(requestId)) continue;
        openPermissionDiffsRef.current.delete(requestId);
        vscode.postMessage({ type: 'closeDiff', data: { path } });
      }
      if (
        permissionToFocus &&
        focusedPermissionRequestIdRef.current !== permissionToFocus
      ) {
        focusedPermissionRequestIdRef.current = permissionToFocus;
        window.requestAnimationFrame(() => {
          const option = document.querySelector<HTMLButtonElement>(
            '[data-web-shell-permission-panel] [data-web-shell-permission-option][tabindex="0"]',
          );
          option?.focus();
        });
      }
    },
    [vscode],
  );

  useEffect(
    () => () => {
      closeOpenPermissionDiffs();
    },
    [closeOpenPermissionDiffs],
  );

  useEffect(() => {
    const openWorkspaceFile = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const filePath = resolveFileLinkFromAnchor(anchor);
      if (!filePath) return;
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({ type: 'openFile', data: { path: filePath } });
    };
    document.addEventListener('click', openWorkspaceFile, true);
    return () => document.removeEventListener('click', openWorkspaceFile, true);
  }, [vscode]);

  useEffect(() => {
    const trackContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      contextMenuRowKeyRef.current =
        target
          ?.closest('[data-message-row-key]')
          ?.getAttribute('data-message-row-key') ?? null;
      vscode.postMessage({ type: 'contextMenuTriggered', data: {} });
    };
    document.addEventListener('contextmenu', trackContextMenu, true);
    return () =>
      document.removeEventListener('contextmenu', trackContextMenu, true);
  }, [vscode]);

  useEffect(() => {
    const handleCopyCommand = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: { action?: string };
      };
      if (message.type !== 'copyCommand') return;

      const blocks = transcriptBlocksRef.current;
      let text: string | null = null;
      if (message.data?.action === 'copyMessage') {
        const block = findBlockByRowKey(blocks, contextMenuRowKeyRef.current);
        text = block ? getBlockCopyText(block) : null;
      } else if (message.data?.action === 'copyAllMessages') {
        text = formatBlocksForCopyAll(blocks);
      } else if (message.data?.action === 'copyLastReply') {
        text = findLastAssistantText(blocks);
      }
      if (text) {
        vscode.postMessage({ type: 'copyToClipboard', data: { text } });
      }
    };
    window.addEventListener('message', handleCopyCommand);
    return () => window.removeEventListener('message', handleCopyCommand);
  }, [vscode]);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind', 'class'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!accountInfo) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountInfo(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [accountInfo]);

  useEffect(() => {
    const receiveBootstrap = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: Record<string, unknown> | ReturnType<typeof readRuntimeConfig>;
      };
      if (
        message.type === 'webShellBootstrap' &&
        typeof message.data?.baseUrl === 'string'
      ) {
        setRuntime(
          message.data as NonNullable<ReturnType<typeof readRuntimeConfig>>,
        );
      } else if (message.type === 'webShellBootstrapError') {
        const errorMessage = (message.data as { message?: unknown } | null)
          ?.message;
        const text =
          typeof errorMessage === 'string' ? errorMessage : t('boot.failed');
        setRuntimeError(text);
        // Before bootstrap this renders as the full-panel startup state. After
        // it, `runtime` is set and that branch is gone, so the same failure
        // would be invisible — show it over the transcript instead.
        if (runtimeRef.current) setHostNotice({ tone: 'error', text });
      } else if (message.type === 'error') {
        const text = (message.data as { message?: unknown } | null)?.message;
        if (typeof text === 'string') setHostNotice({ tone: 'error', text });
      } else if (message.type === 'accountInfo' && message.data) {
        setAccountInfo(message.data as AccountInfo);
      } else if (message.type === 'authState') {
        const state = (message.data as { authenticated?: unknown } | null)
          ?.authenticated;
        setAuthenticated(typeof state === 'boolean' ? state : null);
        if (state === false) {
          setAuthConnecting(false);
          clearInsight();
        } else if (state === true) {
          setAuthConnecting(false);
          setAuthError(undefined);
        }
      } else if (
        message.type === 'authSuccess' ||
        message.type === 'agentConnected'
      ) {
        setAuthenticated(true);
        setAuthConnecting(false);
        setAuthError(undefined);
        if (message.type === 'authSuccess') {
          setHostNotice({ tone: 'info', text: t('auth.signedIn') });
        }
      } else if (message.type === 'authCancelled') {
        // A cancelled auth flow must not hide an already-authenticated
        // session behind the onboarding screen; only an unknown auth state
        // settles to unauthenticated here.
        setAuthenticated((current) => current ?? false);
        setAuthConnecting(false);
        setAuthError(undefined);
        clearInsight();
      } else if (
        message.type === 'authError' ||
        message.type === 'agentConnectionError'
      ) {
        const data = message.data as {
          message?: unknown;
          error?: unknown;
        } | null;
        const text =
          typeof data?.message === 'string'
            ? data.message
            : typeof data?.error === 'string'
              ? data.error
              : t('auth.failed');
        setAuthenticated(false);
        setAuthConnecting(false);
        setAuthError(text);
        clearInsight();
      } else if (message.type === 'insightProgress' && message.data) {
        const data = message.data as {
          stage?: unknown;
          progress?: unknown;
          detail?: unknown;
        };
        if (
          typeof data.stage === 'string' &&
          typeof data.progress === 'number'
        ) {
          setInsightReportPath(undefined);
          setInsightProgress({
            stage: data.stage,
            progress: data.progress,
            detail: typeof data.detail === 'string' ? data.detail : undefined,
          });
        }
      } else if (message.type === 'insightProgressCleared') {
        clearInsight();
      } else if (message.type === 'insightReportReady') {
        const path = (message.data as { path?: unknown } | null)?.path;
        setInsightProgress(undefined);
        setInsightReportPath(typeof path === 'string' ? path : undefined);
      } else if (message.type === 'message' && message.data) {
        const data = message.data as {
          content?: unknown;
          localOnly?: unknown;
        };
        if (data.localOnly && typeof data.content === 'string') {
          setHostNotice({ tone: 'info', text: data.content });
        }
      } else if (message.type === 'exportCompleted' && message.data) {
        const data = message.data as {
          format?: unknown;
          filename?: unknown;
          filePath?: unknown;
        };
        if (
          typeof data.format === 'string' &&
          typeof data.filename === 'string' &&
          typeof data.filePath === 'string'
        ) {
          setHostNotice({
            tone: 'info',
            text: `Session exported to ${data.format}: ${data.filename}`,
            action: { label: 'Open', path: data.filePath },
          });
        }
      } else if (message.type === 'activeEditorChanged') {
        const data = message.data as {
          fileName?: unknown;
          filePath?: unknown;
          selection?: ActiveFileContext['selection'];
        };
        if (
          typeof data.fileName === 'string' &&
          typeof data.filePath === 'string'
        ) {
          setActiveFile({
            fileName: data.fileName,
            filePath: data.filePath,
            selection: data.selection,
          });
          // The host fires this on every selection change, including plain
          // cursor moves; only an actual file change may re-arm inclusion,
          // or a click silently undoes the user's explicit exclusion.
          if (previousActiveFilePathRef.current !== data.filePath) {
            setIncludeActiveFile(true);
          }
          previousActiveFilePathRef.current = data.filePath;
        } else {
          setActiveFile(undefined);
          previousActiveFilePathRef.current = undefined;
        }
      } else if (
        message.type === 'modeChanged' ||
        message.type === 'modeInfo'
      ) {
        const modeData = message.data as {
          modeId?: unknown;
          currentModeId?: unknown;
        } | null;
        const modeId = modeData?.modeId ?? modeData?.currentModeId;
        if (isAutomaticApprovalMode(modeId)) {
          closeOpenPermissionDiffs();
        } else {
          updateTranscript(transcriptBlocksRef.current);
        }
      } else if (message.type === 'fileAttached') {
        const data = message.data as {
          id?: unknown;
          name?: unknown;
          value?: unknown;
        };
        if (typeof data.name === 'string' && typeof data.value === 'string') {
          composerRef.current?.addTags([
            {
              id:
                typeof data.id === 'string'
                  ? data.id
                  : `vscode-file:${data.value}`,
              kind: 'file',
              label: data.name,
              value: data.value,
              metadata: { path: data.value },
              serialized: `@${data.value}`,
            },
          ]);
          composerRef.current?.focus?.();
        }
      }
    };
    window.addEventListener('message', receiveBootstrap);
    vscode.postMessage({ type: 'webShellReady', data: {} });
    return () => window.removeEventListener('message', receiveBootstrap);
  }, [clearInsight, closeOpenPermissionDiffs, t, updateTranscript, vscode]);

  if (!runtime) {
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          flex: '1 1 auto',
          minWidth: 0,
          minHeight: 0,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          color: 'var(--vscode-descriptionForeground)',
        }}
      >
        {!runtimeError && (
          <>
            <style>
              {'@keyframes qwen-vscode-spin{to{transform:rotate(360deg)}}'}
            </style>
            <LoaderCircle
              size={18}
              aria-hidden="true"
              style={{ animation: 'qwen-vscode-spin 0.8s linear infinite' }}
            />
          </>
        )}
        <span>{runtimeError ?? t('boot.starting')}</span>
      </div>
    );
  }

  return (
    <div
      style={{ ...ROOT_STYLE, position: 'relative', flexDirection: 'column' }}
      data-vscode-context='{"webviewSection":"chat-messages"}'
    >
      <style>{VSCODE_EMBEDDED_CSS}</style>
      {sessionHistoryOpen && (
        <SessionHistoryDropdown
          t={t}
          sessions={sessions}
          currentSessionId={runtime.sessionId}
          searchQuery={sessionSearchQuery}
          loading={sessionListLoading}
          hasMore={Boolean(sessionCursor)}
          error={sessionListError}
          onSearchChange={setSessionSearchQuery}
          onClose={closeSessionHistory}
          onLoadMore={() => void loadSessionHistory(sessionCursor)}
          onSelect={(session) => {
            if (session.sessionId === runtime.sessionId) return;
            closeOpenPermissionDiffs();
            clearInsight();
            closeSessionHistory();
            setEditingMessage(undefined);
            composerRef.current?.clear({ text: true, tags: true });
            setSwitchingSessionId(session.sessionId);
            setSessionTitle(session.displayName || t('session.past'));
            setRuntime((current) =>
              current && current.sessionId !== session.sessionId
                ? { ...current, sessionId: session.sessionId }
                : current,
            );
          }}
          onRename={async (session, title) => {
            if (!daemonClient || !runtime.workspaceCwd) return;
            setSessionListError(undefined);
            try {
              const result = await daemonClient
                .workspaceByCwd(runtime.workspaceCwd)
                .updateSessionMetadata(session.sessionId, {
                  displayName: title,
                });
              const displayName = result.displayName || title;
              setSessions((current) =>
                current.map((entry) =>
                  entry.sessionId === session.sessionId
                    ? { ...entry, displayName }
                    : entry,
                ),
              );
              if (session.sessionId === runtime.sessionId) {
                setSessionTitle(displayName);
                if (runtime.hostKind === 'panel') {
                  vscode.postMessage({
                    type: 'updatePanelTitle',
                    data: { title: displayName },
                  });
                }
              }
            } catch (error) {
              setSessionListError(
                error instanceof Error
                  ? error.message
                  : t('session.renameFailed'),
              );
            }
          }}
          onDelete={async (session) => {
            if (
              !daemonClient ||
              !runtime.workspaceCwd ||
              !session.sessionId ||
              session.sessionId === runtime.sessionId
            ) {
              return;
            }
            setSessionListError(undefined);
            try {
              await daemonClient
                .workspaceByCwd(runtime.workspaceCwd)
                .deleteSessionsData([session.sessionId]);
              setSessions((current) =>
                current.filter(
                  (entry) => entry.sessionId !== session.sessionId,
                ),
              );
            } catch (error) {
              setSessionListError(
                error instanceof Error
                  ? error.message
                  : t('session.deleteFailed'),
              );
            }
          }}
        />
      )}
      {(switchingSessionId || creatingSession) && (
        <div
          role="status"
          style={{
            position: 'absolute',
            inset: '30px 0 0',
            zIndex: 900,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            background:
              'color-mix(in srgb, var(--vscode-sideBar-background) 82%, transparent)',
            color: 'var(--vscode-descriptionForeground)',
            backdropFilter: 'blur(2px)',
          }}
        >
          <LoaderCircle
            size={18}
            aria-hidden="true"
            style={{ animation: 'qwen-vscode-spin 0.8s linear infinite' }}
          />
          <span>
            {creatingSession ? t('session.creating') : t('session.switching')}
          </span>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          height: 30,
          flex: '0 0 30px',
          alignItems: 'center',
          gap: 8,
          padding: '0 10px',
          borderBottom: '1px solid var(--vscode-panel-border)',
          background: 'var(--vscode-sideBar-background)',
          color: 'var(--vscode-sideBar-foreground)',
        }}
      >
        <button
          ref={historyButtonRef}
          type="button"
          className="qwen-vscode-header-button"
          title={t('header.history')}
          aria-label={t('header.history')}
          aria-haspopup="dialog"
          aria-expanded={sessionHistoryOpen}
          aria-controls={
            sessionHistoryOpen ? 'qwen-session-history' : undefined
          }
          disabled={Boolean(switchingSessionId || creatingSession)}
          onClick={() => {
            if (sessionHistoryOpen) closeSessionHistory();
            else openSessionHistory();
          }}
          style={{
            display: 'inline-flex',
            minWidth: 0,
            maxWidth: 'calc(100% - 32px)',
            alignItems: 'center',
            gap: 5,
            overflow: 'hidden',
            padding: '2px 6px',
            border: 0,
            borderRadius: 4,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontWeight: 600,
            cursor: switchingSessionId || creatingSession ? 'wait' : 'pointer',
            opacity: switchingSessionId || creatingSession ? 0.55 : 1,
          }}
        >
          <span
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sessionTitle}
          </span>
          <ChevronDown size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="qwen-vscode-header-button"
          title={t('header.newSession')}
          aria-label={t('header.newSession')}
          disabled={Boolean(
            switchingSessionId || creatingSession || authenticated === false,
          )}
          onClick={() => {
            setSessionHistoryOpen(false);
            if (runtime.hostKind === 'panel') {
              vscode.postMessage({
                type: 'openNewChatTab',
                data: currentModelIdRef.current
                  ? { modelId: currentModelIdRef.current }
                  : {},
              });
              return;
            }
            closeOpenPermissionDiffs();
            clearInsight();
            const createNewSession = shellRef.current?.createNewSession;
            if (!createNewSession) return;
            setEditingMessage(undefined);
            composerRef.current?.clear({ text: true, tags: true });
            setCreatingSession(true);
            void createNewSession()
              .then((created) => {
                if (created) {
                  setSessionTitle(t('session.new'));
                  return;
                }
                setHostNotice({
                  tone: 'error',
                  text: t('session.createFailed'),
                });
              })
              .catch((error) => {
                setHostNotice({
                  tone: 'error',
                  text:
                    error instanceof Error
                      ? error.message
                      : t('session.createFailed'),
                });
              })
              .finally(() => setCreatingSession(false));
          }}
          style={{
            display: 'inline-flex',
            width: 24,
            height: 24,
            flex: '0 0 auto',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 0,
            borderRadius: 4,
            background: 'transparent',
            color: 'inherit',
            cursor:
              switchingSessionId || creatingSession
                ? 'wait'
                : authenticated === false
                  ? 'not-allowed'
                  : 'pointer',
            opacity:
              switchingSessionId || creatingSession || authenticated === false
                ? 0.55
                : 1,
          }}
        >
          <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {hostNotice && (
        <div
          role={hostNotice.tone === 'error' ? 'alert' : 'status'}
          style={{
            display: 'flex',
            minWidth: 0,
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderBottom: '1px solid var(--vscode-panel-border)',
            color:
              hostNotice.tone === 'error'
                ? 'var(--vscode-errorForeground)'
                : 'var(--vscode-foreground)',
            background: 'var(--vscode-sideBarSectionHeader-background)',
            fontSize: 12,
          }}
        >
          <span
            style={{
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={hostNotice.text}
          >
            {hostNotice.text}
          </span>
          {hostNotice.action && (
            <button
              type="button"
              onClick={() =>
                vscode.postMessage({
                  type: 'openFile',
                  data: { path: hostNotice.action?.path },
                })
              }
              style={{
                flex: '0 0 auto',
                padding: '2px 6px',
                border: 0,
                borderRadius: 3,
                background: 'var(--vscode-button-secondaryBackground)',
                color: 'var(--vscode-button-secondaryForeground)',
                font: 'inherit',
                cursor: 'pointer',
              }}
            >
              {hostNotice.action.label}
            </button>
          )}
          <button
            type="button"
            title={t('notice.dismiss')}
            aria-label={t('notice.dismiss')}
            onClick={() => setHostNotice(undefined)}
            style={{
              display: 'inline-flex',
              width: 20,
              height: 20,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              border: 0,
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {(insightProgress || insightReportPath) && (
        <div
          data-testid="insight-status"
          role="status"
          style={{
            display: 'flex',
            minWidth: 0,
            alignItems: 'center',
            gap: 10,
            padding: '6px 10px',
            borderBottom: '1px solid var(--vscode-panel-border)',
            background: 'var(--vscode-sideBarSectionHeader-background)',
            color: 'var(--vscode-foreground)',
            fontSize: 12,
          }}
        >
          {insightProgress ? (
            <>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {insightProgress.stage}
                </div>
                <div
                  title={insightProgress.detail ?? t('insight.progressDetail')}
                  style={{
                    overflow: 'hidden',
                    color: 'var(--vscode-descriptionForeground)',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {insightProgress.detail ?? t('insight.progressDetail')}
                </div>
              </div>
              <span
                style={{ flex: '0 0 auto', fontVariantNumeric: 'tabular-nums' }}
              >
                {Math.max(
                  0,
                  Math.min(100, Math.round(insightProgress.progress)),
                )}
                %
              </span>
            </>
          ) : (
            <>
              <span
                title={insightReportPath}
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('insight.ready')} {insightReportPath}
              </span>
              <button
                type="button"
                onClick={() =>
                  vscode.postMessage({
                    type: 'openInsightReport',
                    data: { path: insightReportPath },
                  })
                }
                style={{
                  flex: '0 0 auto',
                  padding: '2px 8px',
                  border: 0,
                  borderRadius: 3,
                  background: 'var(--vscode-button-secondaryBackground)',
                  color: 'var(--vscode-button-secondaryForeground)',
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Open
              </button>
            </>
          )}
        </div>
      )}
      {authenticated === false ? (
        <QwenOnboarding
          connecting={authConnecting}
          error={authError}
          t={t}
          onGetStarted={() => {
            setAuthConnecting(true);
            setAuthError(undefined);
            vscode.postMessage({ type: 'auth', data: {} });
          }}
        />
      ) : (
        <WebShellWithProviders
          baseUrl={runtime.baseUrl}
          token={runtime.token}
          clientId={runtime.clientId}
          lockWorkspaceCwd={runtime.workspaceCwd}
          sessionId={runtime.sessionId}
          className="qwen-code-vscode-web-shell"
          style={SHELL_STYLE}
          theme={theme}
          language={language}
          sessionSourceType={VSCODE_SESSION_SOURCE_TYPE}
          shellRef={shellRef}
          header={{ items: [] }}
          onSessionIdChange={(sessionId) => {
            if (switchingSessionId && sessionId !== switchingSessionId) return;
            clearInsight();
            setEditingMessage(undefined);
            vscode.postMessage({
              type: 'webShellSessionChanged',
              data: { sessionId, workspaceCwd: runtime.workspaceCwd },
            });
            setRuntime((current) =>
              current && current.sessionId !== sessionId
                ? { ...current, sessionId }
                : current,
            );
            if (sessionId === switchingSessionId) {
              setSwitchingSessionId(undefined);
            }
          }}
          onSessionInfoChange={({ sessionId, sessionName }) => {
            if (!switchingSessionId || sessionId === switchingSessionId) {
              const title = sessionName || t('session.new');
              setSessionTitle(title);
              if (runtime.hostKind === 'panel') {
                vscode.postMessage({
                  type: 'updatePanelTitle',
                  data: { title },
                });
              }
            }
          }}
          onError={handleShellError}
          sidebar={false}
          compactThinking
          collapseCompletedTurns
          composerToolbarActions={COMPOSER_TOOLBAR_ACTIONS}
          compactComposerOverlays
          autoSubmitSlashCommands
          additionalSlashCommands={slashCommands}
          hiddenSlashCommands={[...VSCODE_HIDDEN_SLASH_COMMANDS]}
          onSlashCommand={({ command, input }) => {
            if (command === 'auth' || command === 'login') {
              vscode.postMessage({ type: 'auth', data: {} });
              return true;
            }
            if (command === 'account') {
              vscode.postMessage({ type: 'getAccountInfo', data: {} });
              return true;
            }
            if (command === 'export') {
              vscode.postMessage({
                type: 'exportSession',
                data: { text: input, sessionId: runtime.sessionId },
              });
              return true;
            }
            return false;
          }}
          contextUsageAlwaysVisible
          userMessageEditing
          cycleModeOnTab
          onUserMessageEditRequest={(turnIndex, content) => {
            composerRef.current?.clear({ text: true, tags: true });
            composerRef.current?.setText(content);
            composerRef.current?.focus?.();
            setEditingMessage({ turnIndex });
            return true;
          }}
          messageTurnOutputs={['file']}
          onFileReviewOpen={openReviewDiff}
          onInsightReportOpen={(path) =>
            vscode.postMessage({
              type: 'openInsightReport',
              data: { path },
            })
          }
          onTranscriptChange={updateTranscript}
          composerPlaceholders={{
            idle: t('composer.placeholder'),
          }}
          composerRef={composerRef}
          prepareSubmit={async (submission) => {
            if (editingMessage) {
              const sessionId = submission.sessionId ?? runtime.sessionId;
              if (!daemonClient || !sessionId) {
                throw new Error(t('composer.editUnavailable'));
              }
              const { snapshots } =
                await daemonClient.getRewindSnapshots(sessionId);
              const snapshot = snapshots.find(
                (entry) => entry.turnIndex === editingMessage.turnIndex,
              );
              if (!snapshot) {
                throw new Error(t('composer.editExpired'));
              }
              await daemonClient.rewindSession(sessionId, snapshot.promptId, {
                clientId: runtime.clientId,
                rewindFiles: false,
              });
              setEditingMessage(undefined);
              clearInsight();
            }

            if (!activeFile || !includeActiveFile) return undefined;
            const normalizedWorkspace = runtime.workspaceCwd?.replace(
              /\\/g,
              '/',
            );
            const normalizedFile = activeFile.filePath.replace(/\\/g, '/');
            const relativePath =
              normalizedWorkspace &&
              normalizedFile.startsWith(`${normalizedWorkspace}/`)
                ? normalizedFile.slice(normalizedWorkspace.length + 1)
                : activeFile.fileName;
            const reference = `@${relativePath}`;
            const selectedLines = activeFile.selection
              ? ` (selected lines ${activeFile.selection.startLine}-${activeFile.selection.endLine})`
              : '';
            // Mention annotations carry the workspace-relative path the
            // file picker produced, so compare in both path spaces.
            const alreadyIncluded = submission.inputAnnotations.some(
              (annotation) =>
                annotation.reference.value === activeFile.filePath ||
                annotation.reference.value === relativePath,
            );
            // Bounded match: `@editor.ts` must not suppress a typed
            // `@editor.tsx` mention of a sibling file.
            const mentionsReference =
              submission.prompt === reference ||
              submission.prompt.startsWith(`${reference} `);
            const prefix =
              alreadyIncluded || mentionsReference
                ? ''
                : `${reference}${selectedLines} `;
            const prompt = `${prefix}${submission.prompt}`;
            const inputAnnotations = submission.inputAnnotations.map(
              (annotation) =>
                prefix
                  ? {
                      ...annotation,
                      start: annotation.start + prefix.length,
                      end: annotation.end + prefix.length,
                    }
                  : annotation,
            );
            if (!alreadyIncluded) {
              inputAnnotations.unshift({
                type: 'reference',
                start: 0,
                end: reference.length,
                text: reference,
                reference: {
                  id: `vscode-active-file:${activeFile.filePath}`,
                  kind: 'file',
                  label: activeFile.fileName,
                  value: activeFile.filePath,
                  metadata: {
                    path: activeFile.filePath,
                    selection: activeFile.selection,
                  },
                  serialized: reference,
                },
              });
            }
            return {
              prompt,
              inputAnnotations,
            };
          }}
          renderComposerHeader={() =>
            editingMessage ? (
              <div
                style={{
                  display: 'flex',
                  minWidth: 0,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  color: 'var(--vscode-descriptionForeground)',
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('composer.editing')}
                </span>
                <button
                  type="button"
                  className="qwen-vscode-toolbar-button"
                  title={t('composer.cancelEditing')}
                  aria-label={t('composer.cancelEditing')}
                  onClick={cancelMessageEditing}
                  style={{
                    display: 'inline-flex',
                    width: 22,
                    height: 22,
                    flex: '0 0 22px',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    border: 0,
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null
          }
          renderComposerToolbarStart={({ disabled, currentModel }) => {
            currentModelIdRef.current = currentModel || undefined;
            return (
              <span className="qwen-vscode-toolbar-start">
                <button
                  type="button"
                  className="qwen-vscode-toolbar-button"
                  title={t('composer.addContext')}
                  aria-label={t('composer.addContext')}
                  disabled={disabled}
                  onClick={() =>
                    vscode.postMessage({ type: 'attachFile', data: {} })
                  }
                  style={{
                    display: 'inline-flex',
                    width: 28,
                    height: 28,
                    flex: '0 0 28px',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    border: 0,
                    borderRadius: 6,
                    color: 'var(--agent-gray-500)',
                    background: 'transparent',
                    opacity: disabled ? 0.45 : 1,
                    cursor: disabled ? 'default' : 'pointer',
                  }}
                >
                  <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
                {activeFile && (
                  <button
                    type="button"
                    className="qwen-vscode-toolbar-button qwen-vscode-active-file"
                    title={`${includeActiveFile ? t('context.included') : t('context.excluded')}: ${activeFile.filePath}`}
                    aria-label={
                      includeActiveFile
                        ? t('context.exclude')
                        : t('context.include')
                    }
                    onClick={() => setIncludeActiveFile((current) => !current)}
                    style={{
                      display: 'inline-flex',
                      minWidth: 28,
                      maxWidth: 'min(150px, 38vw)',
                      height: 28,
                      alignItems: 'center',
                      gap: 4,
                      overflow: 'hidden',
                      padding: '0 7px',
                      border: 0,
                      borderRadius: 6,
                      color: 'var(--agent-gray-500)',
                      background: 'transparent',
                      opacity: includeActiveFile ? 1 : 0.5,
                      cursor: 'pointer',
                    }}
                  >
                    <FileText
                      size={15}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      style={{ flex: '0 0 auto' }}
                    />
                    <span className="qwen-vscode-active-file-label">
                      {activeFile.selection
                        ? `${activeFile.selection.endLine - activeFile.selection.startLine + 1} lines selected`
                        : activeFile.fileName}
                    </span>
                  </button>
                )}
              </span>
            );
          }}
        />
      )}
      {accountInfo && (
        <div
          role="presentation"
          onClick={() => setAccountInfo(undefined)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 12,
            background: 'rgba(0, 0, 0, 0.45)',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="qwen-account-info-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              display: 'flex',
              width: 'min(480px, 100%)',
              maxHeight: 'min(480px, calc(100% - 24px))',
              flexDirection: 'column',
              overflow: 'hidden',
              border: '1px solid var(--vscode-widget-border)',
              borderRadius: 6,
              background: 'var(--vscode-editorWidget-background)',
              color: 'var(--vscode-editorWidget-foreground)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid var(--vscode-widget-border)',
              }}
            >
              <strong id="qwen-account-info-title" style={{ flex: 1 }}>
                {t('account.title')}
              </strong>
              <button
                type="button"
                title={t('common.close')}
                aria-label={t('common.close')}
                onClick={() => setAccountInfo(undefined)}
                style={{
                  display: 'inline-flex',
                  width: 22,
                  height: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  border: 0,
                  borderRadius: 3,
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content minmax(0, 1fr)',
                gap: '8px 14px',
                overflow: 'auto',
                padding: 12,
                fontSize: 12,
              }}
            >
              {accountInfo.error ? (
                <>
                  <span
                    style={{ color: 'var(--vscode-descriptionForeground)' }}
                  >
                    {t('account.error')}
                  </span>
                  <span style={{ color: 'var(--vscode-errorForeground)' }}>
                    {accountInfo.error}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{ color: 'var(--vscode-descriptionForeground)' }}
                  >
                    {t('account.authType')}
                  </span>
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {accountInfo.authType || t('account.unknown')}
                  </span>
                  {accountInfo.envKey && (
                    <>
                      <span
                        style={{ color: 'var(--vscode-descriptionForeground)' }}
                      >
                        {t('account.envKey')}
                      </span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {accountInfo.envKey}
                      </span>
                    </>
                  )}
                  {accountInfo.baseUrl && (
                    <>
                      <span
                        style={{ color: 'var(--vscode-descriptionForeground)' }}
                      >
                        {t('account.baseUrl')}
                      </span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {accountInfo.baseUrl}
                      </span>
                    </>
                  )}
                  {accountInfo.modelId && (
                    <>
                      <span
                        style={{ color: 'var(--vscode-descriptionForeground)' }}
                      >
                        {t('account.model')}
                      </span>
                      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {accountInfo.modelId}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import type {
  EmbeddedWebShellPermissionRequest,
  EmbeddedWebShellSession,
  EmbeddedWebShellSubmit,
  WebShellAtProvider,
  WebShellComposerInput,
  WebShellTheme,
} from '@qwen-code/web-shell';
import type { AvailableCommand, ModelInfo } from '@agentclientprotocol/sdk';
import { useVSCode } from './hooks/useVSCode.js';
import { useSessionManagement } from './hooks/session/useSessionManagement.js';
import {
  useFileContext,
  type WorkspaceFile,
} from './hooks/file/useFileContext.js';
import { useMessageHandling } from './hooks/message/useMessageHandling.js';
import { useToolCalls } from './hooks/useToolCalls.js';
import { useWebViewMessages } from './hooks/useWebViewMessages.js';
import { useAcpTranscript } from './hooks/useAcpTranscript.js';
import type {
  PermissionOption,
  PermissionToolCall,
} from './types/permissionTypes.js';
import type { Question } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { UsageStatsPayload } from '../types/chatTypes.js';
import { isDisplayableImagePath } from '../utils/imageSupport.js';
import { resolveFileLinkFromAnchor } from './utils/fileLinks.js';
import {
  findBlockByRowKey,
  findLastAssistantText,
  formatBlocksForCopyAll,
  getBlockCopyText,
} from './utils/copyTranscript.js';

type AccountInfo = {
  authType?: string | null;
  baseUrl?: string | null;
  envKey?: string | null;
  modelId?: string | null;
  error?: string;
};

type InsightProgress = {
  stage: string;
  progress: number;
  detail?: string;
};

const LIGHT_THEME_RE = /light/i;

const VSCODE_THEME_STYLE = {
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
  '--chat-editor-bg-primary': 'var(--vscode-input-background)',
  '--chat-editor-bg-tertiary': 'var(--vscode-sideBar-background)',
  '--chat-editor-border-color':
    'var(--vscode-input-border, var(--vscode-widget-border))',
  '--chat-editor-text-primary': 'var(--vscode-input-foreground)',
  '--chat-editor-text-secondary': 'var(--vscode-descriptionForeground)',
  '--chat-editor-text-dimmed': 'var(--vscode-input-placeholderForeground)',
  '--chat-editor-accent-color': 'var(--vscode-focusBorder)',
  '--agent-gray-200': 'var(--vscode-input-border, var(--vscode-widget-border))',
} as CSSProperties;

const EmbeddedWebShell = lazy(() =>
  import('@qwen-code/web-shell').then((module) => ({
    default: module.EmbeddedWebShell,
  })),
);

function readTheme(): WebShellTheme {
  if (typeof document === 'undefined') return 'dark';
  const kind = document.body.getAttribute('data-vscode-theme-kind') ?? '';
  return LIGHT_THEME_RE.test(kind) ? 'light' : 'dark';
}

function mapPermissionKind(
  kind: string | undefined,
  optionId: string,
): 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' {
  if (
    kind === 'allow_once' ||
    kind === 'allow_always' ||
    kind === 'reject_once' ||
    kind === 'reject_always'
  ) {
    return kind;
  }
  const normalized = optionId.toLowerCase();
  const reject = normalized.includes('reject') || normalized.includes('cancel');
  const always = normalized.includes('always') || normalized.includes('server');
  if (reject) return always ? 'reject_always' : 'reject_once';
  return always ? 'allow_always' : 'allow_once';
}

function mapPermissionRequest(
  request: { options: PermissionOption[]; toolCall: PermissionToolCall } | null,
): EmbeddedWebShellPermissionRequest | null {
  if (!request) return null;
  const toolCall = request.toolCall;
  const id = toolCall.toolCallId || `permission-${Date.now()}`;
  const content = (toolCall.content ?? []).map((item) => {
    const text =
      typeof item.text === 'string'
        ? item.text
        : typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item);
    return { type: 'text' as const, text };
  });
  const rawInput =
    toolCall.rawInput && typeof toolCall.rawInput === 'object'
      ? toolCall.rawInput
      : undefined;
  return {
    id,
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    toolKind: toolCall.kind,
    toolName: toolCall.toolName,
    kind: toolCall.kind,
    rawInput,
    content,
    options: request.options.map((option) => ({
      id: option.optionId,
      label: option.name || option.optionId,
      kind: mapPermissionKind(option.kind, option.optionId),
    })),
  };
}

function mapQuestionRequest(
  request: { questions: Question[]; sessionId: string } | null,
): EmbeddedWebShellPermissionRequest | null {
  if (!request) return null;
  return {
    id: request.sessionId || 'ask-user-question',
    sessionId: request.sessionId,
    kind: 'ask_user_question',
    title: 'Ask User Question',
    content: [],
    rawInput: { questions: request.questions },
    options: [
      { id: 'proceed_once', label: 'Submit', kind: 'allow_once' },
      { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
    ],
  };
}

function modelId(model: ModelInfo): string {
  const candidate = (model as ModelInfo & { modelId?: unknown }).modelId;
  return typeof candidate === 'string' && candidate ? candidate : model.name;
}

function modelLabel(model: ModelInfo): string {
  const name = (model as ModelInfo & { name?: unknown }).name;
  return typeof name === 'string' && name ? name : modelId(model);
}

function mapCommands(commands: AvailableCommand[]) {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    argumentHint: command.input?.hint,
  }));
}

function mapSessions(
  sessions: Array<Record<string, unknown>>,
): EmbeddedWebShellSession[] {
  return sessions.flatMap((session) => {
    const id =
      typeof session.id === 'string'
        ? session.id
        : typeof session.sessionId === 'string'
          ? session.sessionId
          : null;
    if (!id) return [];
    const title =
      (typeof session.title === 'string' && session.title) ||
      (typeof session.name === 'string' && session.name) ||
      'Past Conversations';
    const updatedAt =
      typeof session.updatedAt === 'string' ||
      typeof session.updatedAt === 'number'
        ? session.updatedAt
        : undefined;
    const messageCount =
      typeof session.messageCount === 'number'
        ? session.messageCount
        : undefined;
    return [{ id, title, updatedAt, messageCount }];
  });
}

function mapImageAttachment(
  image: { data: string; media_type: string },
  index: number,
) {
  const payload = image.data.replace(/^data:[^;]+;base64,/, '');
  return {
    id: `embedded-image-${Date.now()}-${index}`,
    name: `pasted-image-${index + 1}`,
    type: image.media_type,
    size: Math.max(1, Math.floor((payload.length * 3) / 4)),
    data: image.data,
    timestamp: Date.now(),
  };
}

function accountNotice(info: AccountInfo): string {
  if (info.error) return `Account: ${info.error}`;
  const rows = [
    info.authType ? `Auth: ${info.authType}` : '',
    info.modelId ? `Model: ${info.modelId}` : '',
    info.envKey ? `API key: ${info.envKey}` : '',
    info.baseUrl ? `Base URL: ${info.baseUrl}` : '',
  ].filter(Boolean);
  return rows.length > 0
    ? rows.join(' · ')
    : 'Account information unavailable.';
}

export function EmbeddedApp() {
  const vscode = useVSCode();
  const inputFieldRef = useRef<HTMLDivElement | null>(null);
  const sessionManagement = useSessionManagement(vscode);
  const fileContext = useFileContext(vscode);
  const messageHandling = useMessageHandling();
  const {
    inProgressToolCalls,
    handleToolCallUpdate,
    clearToolCalls,
    rewindToolCallsToTimestamp,
  } = useToolCalls();

  const blocks = useAcpTranscript();
  const [permissionRequest, setPermissionRequest] = useState<{
    options: PermissionOption[];
    toolCall: PermissionToolCall;
  } | null>(null);
  const [questionRequest, setQuestionRequest] = useState<{
    questions: Question[];
    sessionId: string;
    metadata?: { source?: string };
  } | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [availableCommands, setAvailableCommands] = useState<
    AvailableCommand[]
  >([]);
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [editMode, setEditMode] = useState<ApprovalModeValue>('default');
  const [usageStats, setUsageStats] = useState<UsageStatsPayload | null>(null);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [insightProgress, setInsightProgress] =
    useState<InsightProgress | null>(null);
  const [insightReportPath, setInsightReportPath] = useState<string | null>(
    null,
  );
  const [uiError, setUiError] = useState<string | null>(null);
  const [webShellTheme, setWebShellTheme] = useState<WebShellTheme>(readTheme);
  const transcriptBlocksRef = useRef(blocks);
  const contextMenuRowKeyRef = useRef<string | null>(null);

  useEffect(() => {
    transcriptBlocksRef.current = blocks;
  }, [blocks]);

  useEffect(() => {
    const trackTarget = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest('[data-message-row-key]');
      const root = target?.closest('[data-web-shell-embedded-host]');
      contextMenuRowKeyRef.current =
        root && row ? row.getAttribute('data-message-row-key') : null;
      if (root) {
        vscode.postMessage({ type: 'contextMenuTriggered', data: {} });
      }
    };
    document.addEventListener('contextmenu', trackTarget, true);
    return () => document.removeEventListener('contextmenu', trackTarget, true);
  }, [vscode]);

  useEffect(() => {
    const handleCopyCommand = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        data?: { action?: string };
      };
      if (message?.type !== 'copyCommand') return;
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
    const root = document.querySelector<HTMLElement>(
      '[data-web-shell-embedded-host]',
    );
    if (!root) return;
    if (blocks.length > 0 || messageHandling.isStreaming) {
      root.setAttribute(
        'data-vscode-context',
        JSON.stringify({ webviewSection: 'chat-messages' }),
      );
    } else {
      root.removeAttribute('data-vscode-context');
    }
  }, [blocks.length, messageHandling.isStreaming]);

  useWebViewMessages({
    sessionManagement,
    fileContext,
    messageHandling,
    handleToolCallUpdate,
    clearToolCalls,
    rewindToolCallsToTimestamp,
    setPlanEntries: () => undefined,
    handlePermissionRequest: setPermissionRequest,
    handleAskUserQuestion: setQuestionRequest,
    inputFieldRef,
    setInputText: () => undefined,
    setEditMode,
    setIsAuthenticated,
    setUsageStats: (stats) => setUsageStats(stats ?? null),
    setModelInfo,
    setAvailableCommands,
    setAvailableSkills,
    setAvailableModels,
    setAccountInfo: (info) => setAccountInfo(info),
    setInsightProgress,
    setInsightReportPath,
  });

  useEffect(() => {
    if (isAuthenticated !== null) {
      setIsLoading(false);
      return;
    }
    const timeout = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(timeout);
  }, [isAuthenticated]);

  useEffect(() => {
    const observer = new MutationObserver(() => setWebShellTheme(readTheme()));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-vscode-theme-kind', 'class'],
    });
    return () => observer.disconnect();
  }, []);

  const pendingPermission = useMemo(
    () => mapPermissionRequest(permissionRequest),
    [permissionRequest],
  );
  const pendingQuestion = useMemo(
    () => mapQuestionRequest(questionRequest),
    [questionRequest],
  );
  const sessions = useMemo(
    () => mapSessions(sessionManagement.filteredSessions),
    [sessionManagement.filteredSessions],
  );
  const commands = useMemo(
    () => mapCommands(availableCommands),
    [availableCommands],
  );
  const skills = useMemo(
    () => availableSkills.map((name) => ({ name, description: '' })),
    [availableSkills],
  );
  const models = useMemo(
    () =>
      availableModels.map((model) => ({
        id: modelId(model),
        label: modelLabel(model),
      })),
    [availableModels],
  );
  const atProviders = useMemo<readonly WebShellAtProvider[]>(
    () => [
      {
        id: 'files',
        label: 'Files',
        description: 'Search workspace files',
        search: async ({
          query,
          signal,
        }: {
          query: string;
          signal: AbortSignal;
        }) => {
          const files = await fileContext.searchWorkspaceFiles(query, signal);
          if (signal.aborted) return [];
          return files.map((file: WorkspaceFile) => ({
            id: file.id,
            label: file.label,
            description: file.description,
            insertText: `@${file.description} `,
          }));
        },
      },
    ],
    [fileContext],
  );

  const onSubmit = useCallback(
    (submission: EmbeddedWebShellSubmit): boolean => {
      const text = submission.text.trim();
      if (text === '/auth' || text === '/login') {
        vscode.postMessage({ type: 'auth', data: {} });
        messageHandling.setWaitingForResponse();
        return true;
      }
      if (text === '/account') {
        vscode.postMessage({ type: 'getAccountInfo', data: {} });
        return true;
      }
      if (
        !text &&
        (!submission.images || submission.images.length === 0) &&
        (!submission.files || submission.files.length === 0)
      ) {
        return false;
      }

      const context: Array<{
        type: string;
        name: string;
        value: string;
        startLine?: number;
        endLine?: number;
        isImage?: boolean;
      }> = fileContext.getFileReferences(submission.text).map((ref) => ({
        type: 'file',
        name: ref.name,
        value: ref.value,
        isImage: isDisplayableImagePath(ref.value),
      }));
      if (fileContext.activeFilePath) {
        context.push({
          type: 'file',
          name: fileContext.activeFileName || 'current file',
          value: fileContext.activeFilePath,
          startLine: fileContext.activeSelection?.startLine,
          endLine: fileContext.activeSelection?.endLine,
          isImage: isDisplayableImagePath(fileContext.activeFilePath),
        });
      }

      const fileContextForMessage = fileContext.activeFilePath
        ? {
            fileName: fileContext.activeFileName || 'current file',
            filePath: fileContext.activeFilePath,
            startLine: fileContext.activeSelection?.startLine,
            endLine: fileContext.activeSelection?.endLine,
          }
        : undefined;
      const attachments = submission.images?.map(mapImageAttachment);

      try {
        messageHandling.setWaitingForResponse();
        vscode.postMessage({
          type: 'sendMessage',
          data: {
            text: submission.text,
            context: context.length > 0 ? context : undefined,
            fileContext: fileContextForMessage,
            attachments:
              attachments && attachments.length > 0 ? attachments : undefined,
            inlineFiles: submission.files?.flatMap(
              (file: NonNullable<EmbeddedWebShellSubmit['files']>[number]) =>
                typeof file.text === 'string'
                  ? [
                      {
                        name: file.name,
                        mediaType: file.media_type,
                        text: file.text,
                      },
                    ]
                  : [],
            ),
            inputAnnotations: submission.inputAnnotations,
          },
        });
        fileContext.clearFileReferences();
        return true;
      } catch (error) {
        messageHandling.clearWaitingForResponse();
        setUiError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [fileContext, messageHandling, vscode],
  );

  const onCancel = useCallback(() => {
    if (messageHandling.isStreaming) {
      messageHandling.endStreaming();
      messageHandling.addMessage({
        role: 'assistant',
        content: 'Interrupted',
        timestamp: Date.now(),
        localOnly: true,
      });
    }
    vscode.postMessage({ type: 'cancelStreaming', data: {} });
  }, [messageHandling, vscode]);

  const onPermissionResponse = useCallback(
    (requestId: string, optionId: string) => {
      void requestId;
      vscode.postMessage({ type: 'permissionResponse', data: { optionId } });
      setPermissionRequest(null);
    },
    [vscode],
  );

  const onQuestionResponse = useCallback(
    async (
      requestId: string,
      optionId: string,
      answers?: Record<string, string>,
    ): Promise<boolean> => {
      void requestId;
      vscode.postMessage({
        type: 'askUserQuestionResponse',
        data: { answers: answers ?? {}, cancelled: optionId === 'cancel' },
      });
      setQuestionRequest(null);
      return true;
    },
    [vscode],
  );

  const onLinkClick = useCallback(
    (href: string, anchorText: string): boolean => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', href);
      anchor.textContent = anchorText;
      const filePath = resolveFileLinkFromAnchor(anchor);
      if (!filePath) return false;
      vscode.postMessage({ type: 'openFile', data: { path: filePath } });
      return true;
    },
    [vscode],
  );

  const onOpenAccount = useCallback(() => {
    setUiError(null);
    vscode.postMessage({ type: 'getAccountInfo', data: {} });
  }, [vscode]);
  const onAuthenticate = useCallback(() => {
    vscode.postMessage({ type: 'auth', data: {} });
    messageHandling.setWaitingForResponse();
  }, [messageHandling, vscode]);
  const onSelectMode = useCallback(
    (modeId: string) =>
      vscode.postMessage({ type: 'setApprovalMode', data: { modeId } }),
    [vscode],
  );
  const onSelectModel = useCallback(
    (selectedModelId: string) =>
      vscode.postMessage({
        type: 'setModel',
        data: { modelId: selectedModelId },
      }),
    [vscode],
  );

  const notices = useMemo(() => {
    const next: Array<{
      id: string;
      message: string;
      tone?: 'info' | 'error';
      actionLabel?: string;
    }> = [];
    if (uiError) {
      next.push({ id: 'embedded-error', message: uiError, tone: 'error' });
    }
    if (accountInfo) {
      next.push({ id: 'account-info', message: accountNotice(accountInfo) });
    }
    if (insightProgress) {
      next.push({
        id: 'insight-progress',
        message: `${insightProgress.stage} ${Math.round(insightProgress.progress)}%${insightProgress.detail ? ` · ${insightProgress.detail}` : ''}`,
      });
    }
    if (insightReportPath) {
      next.push({
        id: 'insight-report',
        message: `Insight report: ${insightReportPath}`,
        actionLabel: 'Open report',
      });
    }
    for (const [index, message] of messageHandling.messages.entries()) {
      if (message.localOnly) {
        next.push({
          id: `local-${message.timestamp}-${index}`,
          message: message.content,
          tone: message.content.toLowerCase().includes('failed')
            ? 'error'
            : 'info',
        });
      }
    }
    return next;
  }, [
    accountInfo,
    insightProgress,
    insightReportPath,
    messageHandling.messages,
    uiError,
  ]);

  const input: WebShellComposerInput | undefined = undefined;
  const usageInputTokens =
    usageStats?.usage?.inputTokens ?? usageStats?.usage?.promptTokens ?? 0;
  const contextWindow =
    usageStats?.tokenLimit ??
    (typeof modelInfo?._meta?.['contextLimit'] === 'number'
      ? modelInfo._meta['contextLimit']
      : 0);

  return (
    <Suspense
      fallback={
        <div
          role="status"
          style={{
            display: 'grid',
            height: '100vh',
            placeItems: 'center',
            color: 'var(--vscode-descriptionForeground)',
          }}
        >
          Preparing Qwen Code...
        </div>
      }
    >
      <EmbeddedWebShell
        blocks={blocks}
        theme={webShellTheme}
        style={VSCODE_THEME_STYLE}
        loading={isLoading || sessionManagement.isSwitchingSession}
        loadingLabel={
          sessionManagement.isSwitchingSession
            ? 'Loading conversation...'
            : 'Preparing Qwen Code...'
        }
        authenticated={isAuthenticated}
        sessionId={sessionManagement.currentSessionId ?? undefined}
        sessionTitle={sessionManagement.currentSessionTitle}
        sessions={sessions}
        historyOpen={sessionManagement.showSessionSelector}
        historySearch={sessionManagement.sessionSearchQuery}
        historyLoading={sessionManagement.isLoading}
        historyHasMore={sessionManagement.hasMore}
        isResponding={
          messageHandling.isStreaming ||
          messageHandling.isWaitingForResponse ||
          inProgressToolCalls.length > 0
        }
        isPreparing={isLoading || sessionManagement.isSwitchingSession}
        commands={commands}
        skills={skills}
        availableModels={models}
        currentModel={modelInfo ? modelId(modelInfo) : ''}
        currentMode={editMode}
        tokenCount={usageInputTokens}
        contextWindow={contextWindow}
        composerInput={input}
        atProviders={atProviders}
        pendingPermission={isAuthenticated ? pendingPermission : null}
        pendingQuestion={isAuthenticated ? pendingQuestion : null}
        notices={notices}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onAuthenticate={onAuthenticate}
        onOpenAccount={onOpenAccount}
        onNewSession={() =>
          sessionManagement.handleNewQwenSession(
            modelInfo ? modelId(modelInfo) : null,
          )
        }
        onHistoryOpenChange={(open: boolean) => {
          if (open) sessionManagement.handleLoadQwenSessions();
          else sessionManagement.setShowSessionSelector(false);
        }}
        onHistorySearchChange={sessionManagement.setSessionSearchQuery}
        onSessionSelect={sessionManagement.handleSwitchSession}
        onLoadMoreSessions={sessionManagement.handleLoadMoreSessions}
        onSelectModel={onSelectModel}
        onSelectMode={onSelectMode}
        onShowContextUsage={() =>
          vscode.postMessage({
            type: 'sendMessage',
            data: { text: '/context' },
          })
        }
        onPermissionResponse={onPermissionResponse}
        onQuestionResponse={onQuestionResponse}
        onNoticeAction={(noticeId: string) => {
          if (noticeId === 'insight-report' && insightReportPath) {
            vscode.postMessage({
              type: 'openInsightReport',
              data: { path: insightReportPath },
            });
          }
        }}
        onError={(error: unknown) =>
          setUiError(error instanceof Error ? error.message : String(error))
        }
        onLinkClick={onLinkClick}
      />
    </Suspense>
  );
}

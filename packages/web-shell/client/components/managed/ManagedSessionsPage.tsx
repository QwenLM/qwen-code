import { ManagedUserMessageQueue } from './ManagedUserMessageQueue';
import { useManagedUserMessages } from './use-managed-user-messages';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../i18n';
import { useManagedRecoveryText } from './managed-recovery-messages';
import shellStyles from '../../App.module.css';
import { MessageList } from '../MessageList';
import {
  ToolDetailsContext,
  type ToolDetailsLoader,
} from '../messages/tools/ToolDetailsContext';
import { ChatEditor } from '../ChatEditor';
import type { WorkspaceSelectorOption } from '../WorkspaceSelector';
import { WelcomeHeader } from '../WelcomeHeader';
import { ChatContextHeader } from '../ChatContextHeader';
import { SessionRenameDialog } from '../dialogs/SessionRenameDialog';
import type {
  EditorHandle,
  ComposerSubmitCommit,
} from '../../hooks/useComposerCore';
import {
  clearComposerDraftIfMatches,
  captureComposerDraftGuard,
  getComposerDraftStorageKey,
} from '../../hooks/useComposerCore';
import { ToolApproval } from '../messages/ToolApproval';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { createManagedMessageProjector } from './managed-session-messages';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';
import { useManagedFileReferences } from './use-managed-file-references';
import type { ComposerSubmitMetadata } from '../../hooks/useComposerCore';
import { useManagedSession } from './use-managed-session';
import {
  ManagedSessionActions,
  ManagedLifecycleConfirmation,
} from './ManagedSessionActions';
import { useManagedSessionLifecycle } from './use-managed-session-lifecycle';
import { downloadManagedSession } from './managed-session-export';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type { ManagedLifecycleAction } from './managed-agent-provider';
import { useManagedRecovery } from './use-managed-recovery';
import { useManagedTurnCancel } from './use-managed-turn-cancel';
import { ManagedRecoveryPanel } from './ManagedRecoveryPanel';
import {
  buildManagedRecoveryHandoff,
  type ManagedRecoveryHandoff,
} from './managed-recovery-handoff';
import { useManagedSessionRename } from './use-managed-session-rename';
import { useManagedActions } from './use-managed-actions';
import { useManagedContextCompression } from './use-managed-context-compression';
import { useManagedModelChange } from './use-managed-model-change';
import { useManagedApprovalChange } from './use-managed-approval-change';
import { ManagedPermissionRulesDialog } from './ManagedPermissionRulesDialog';
import { useManagedSkills } from './use-managed-skills';
import { useManagedMcp } from './use-managed-mcp';
import { toManagedPermissionRequest } from './managed-approval';
import { isNonRetryableClientError } from './managed-request-error';
import { ManagedSessionProgress } from './ManagedSessionProgress';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';
import { ManagedWorktreeStatus } from './ManagedSessionWorktrees';
import type { ManagedCreationSkillsSource } from './managed-creation-skills';
import { ManagedWorkspaceNavigation } from './ManagedWorkspaceNavigation';
import { ManagedSessionNavigationRow } from './ManagedSessionNavigationRow';
import {
  ManagedArchivedSessions,
  type ManagedArchivedSessionsStatus,
} from './ManagedArchivedSessions';
import { isManagedSessionRunning } from './managed-agent-provider';
import { ManagedToolResultPanel } from './ManagedToolResultPanel';
import { ManagedTaskPanel, taskCancelMessage } from './ManagedTaskPanel';
import { useManagedTasks } from './use-managed-tasks';
import { ManagedChildSessionView } from './ManagedChildSessionView';
import { useManagedTaskCancel } from './use-managed-task-cancel';
import { TodoFullList } from '../messages/TodoView';
import { getLatestSuccessfulTodos } from '../../utils/todos';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedAgentWorkspace,
  ManagedInputBlock,
} from './managed-agent-provider';
import type { PromptImage, PromptFile } from '../../adapters/promptTypes';
import {
  encodeManagedInput,
  isManagedInput,
  restoreManagedAttachments,
} from './managed-input';
import {
  readManagedPending,
  saveManagedPending,
} from './managed-pending-storage';

interface PendingPrompt {
  idempotencyKey: string;
  text: string;
  draftText?: string;
  queued?: boolean;
  sessionId?: string;
  input?: ManagedInputBlock[];
}

function mergeManagedSessionCatalog(
  current: ManagedAgentSessionSummary[],
  page: ManagedAgentSessionSummary[],
): ManagedAgentSessionSummary[] {
  const known = new Map(current.map((session) => [session.sessionId, session]));
  const merged = new Map<string, ManagedAgentSessionSummary>();
  for (const session of page) {
    const previous = known.get(session.sessionId);
    merged.set(
      session.sessionId,
      previous && previous.updatedAt >= session.updatedAt ? previous : session,
    );
  }
  for (const session of current) {
    if (!merged.has(session.sessionId)) merged.set(session.sessionId, session);
  }
  return [...merged.values()];
}

function readPending(
  key: string,
  restored?: unknown,
): PendingPrompt | undefined {
  try {
    const value: unknown =
      restored ?? JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const pending = value as Record<string, unknown>;
    if (
      typeof pending['idempotencyKey'] !== 'string' ||
      typeof pending['text'] !== 'string' ||
      (pending['queued'] !== undefined &&
        typeof pending['queued'] !== 'boolean') ||
      (pending['input'] !== undefined && !isManagedInput(pending['input']))
    )
      return undefined;
    if (
      pending['sessionId'] !== undefined &&
      typeof pending['sessionId'] !== 'string'
    )
      return undefined;
    if (
      pending['draftText'] !== undefined &&
      typeof pending['draftText'] !== 'string'
    )
      return undefined;
    return value as PendingPrompt;
  } catch {
    return undefined;
  }
}

async function persistPending(
  key: string,
  value: PendingPrompt | undefined,
): Promise<boolean> {
  return saveManagedPending(key, value);
}

export function ManagedSessionsPage({
  sessionId,
  workspaceCreationOpen,
  onWorkspaceCreationOpenChange,
  onWorkspaceCreated,
  onOpenLocalWorkspace,
  daemonWorkspaces,
  onSelectDaemonWorkspace,
  onWorkspacesChange,
  onSelectSession,
  onOpenSession,
  workspaceId,
  onSelectWorkspace,
  onSessionWorkspaceChange,
  managedAgentProvider,
  hostSessionOnly = false,
  navigationTarget,
  archivedNavigationTarget,
  onArchivedSessionsStatusChange,
  interactive = true,
  creationSkills,
  navigationActive = interactive,
  navigationSearch = '',
}: {
  sessionId?: string;
  workspaceCreationOpen?: boolean;
  onWorkspaceCreationOpenChange?: (open: boolean) => void;
  onWorkspaceCreated?: (workspaceId: string) => void;
  onOpenLocalWorkspace?: () => void;
  daemonWorkspaces?: WorkspaceSelectorOption[];
  onSelectDaemonWorkspace?: (workspace: WorkspaceSelectorOption) => void;
  onWorkspacesChange?: (workspaces: ManagedAgentWorkspace[]) => void;
  onSelectSession: (
    sessionId: string | undefined,
    workspaceId?: string,
  ) => void;
  onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  workspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSessionWorkspaceChange?: (workspaceId: string | null) => void;
  managedAgentProvider?: ManagedAgentProvider;
  hostSessionOnly?: boolean;
  /** Null keeps home layout while its sidebar slot is temporarily unmounted. */
  navigationTarget?: HTMLElement | null;
  archivedNavigationTarget?: HTMLElement | null;
  onArchivedSessionsStatusChange?: (
    status: ManagedArchivedSessionsStatus,
  ) => void;
  interactive?: boolean;
  creationSkills?: ManagedCreationSkillsSource;
  navigationActive?: boolean;
  navigationSearch?: string;
}) {
  const { t } = useI18n();
  if (managedAgentProvider) {
    return (
      <ManagedSessionsContent
        key={managedAgentProvider.storageKey}
        sessionId={sessionId}
        workspaceCreationOpen={workspaceCreationOpen}
        onWorkspaceCreationOpenChange={onWorkspaceCreationOpenChange}
        onWorkspaceCreated={onWorkspaceCreated}
        onOpenLocalWorkspace={onOpenLocalWorkspace}
        daemonWorkspaces={daemonWorkspaces}
        onSelectDaemonWorkspace={onSelectDaemonWorkspace}
        onWorkspacesChange={onWorkspacesChange}
        onSelectSession={onSelectSession}
        onOpenSession={onOpenSession}
        workspaceId={workspaceId}
        onSelectWorkspace={onSelectWorkspace}
        onSessionWorkspaceChange={onSessionWorkspaceChange}
        provider={managedAgentProvider}
        hostSessionOnly={hostSessionOnly}
        cancellationEnabled={managedAgentProvider.canCancel}
        navigationTarget={navigationTarget}
        archivedNavigationTarget={archivedNavigationTarget}
        onArchivedSessionsStatusChange={onArchivedSessionsStatusChange}
        interactive={interactive}
        creationSkills={creationSkills}
        navigationActive={navigationActive}
        navigationSearch={navigationSearch}
      />
    );
  }
  return <p role="status">{t('managed.unavailable')}</p>;
}

const FAILURE_MESSAGES: Record<string, readonly [string, string]> = {
  model_payment_required: [
    'Model API payment required (HTTP 402). Check the provider account balance and billing before retrying.',
    '模型接口要求支付（HTTP 402），可能是余额不足或计费受限。请检查供应商账户余额与计费状态后重试。',
  ],
  model_authentication_failed: [
    'Model API authentication failed (HTTP 401). Check the configured provider credentials.',
    '模型接口鉴权失败（HTTP 401）。请检查供应商凭据配置。',
  ],
  model_access_denied: [
    'Model API access denied (HTTP 403). Check the provider account and model permissions.',
    '模型接口拒绝访问（HTTP 403）。请检查供应商账户与模型访问权限。',
  ],
  model_request_timeout: [
    'The model API request timed out. Try again later.',
    '模型接口请求超时，请稍后重试。',
  ],
  model_rate_limited: [
    'Model API rate limit exceeded (HTTP 429). Wait and try again later.',
    '模型接口触发限流（HTTP 429），请稍后重试。',
  ],
  model_request_rejected: [
    'The model API rejected the request. Check the model configuration and input.',
    '模型接口拒绝了请求，请检查模型配置与输入内容。',
  ],
  model_service_unavailable: [
    'The model API service is unavailable. Try again later.',
    '模型接口服务暂不可用，请稍后重试。',
  ],
  model_request_failed: [
    'Model API request failed. Check the server logs for this session before retrying.',
    '模型接口请求失败，请根据当前会话检查服务日志后再重试。',
  ],
  hosted_turn_failed: [
    'The turn failed. Check the server logs for this session to identify the cause.',
    '本轮执行失败，请根据当前会话检查服务日志以定位具体原因。',
  ],
};

function ManagedSessionsContent({
  sessionId,
  workspaceCreationOpen,
  onWorkspaceCreationOpenChange,
  onWorkspaceCreated,
  onOpenLocalWorkspace,
  daemonWorkspaces,
  onSelectDaemonWorkspace,
  onWorkspacesChange,
  onSelectSession,
  onOpenSession,
  workspaceId,
  onSelectWorkspace,
  onSessionWorkspaceChange,
  provider,
  hostSessionOnly,
  cancellationEnabled,
  navigationTarget,
  archivedNavigationTarget,
  onArchivedSessionsStatusChange,
  interactive,
  creationSkills,
  navigationActive,
  navigationSearch,
}: {
  sessionId?: string;
  workspaceCreationOpen?: boolean;
  onWorkspaceCreationOpenChange?: (open: boolean) => void;
  onWorkspaceCreated?: (workspaceId: string) => void;
  onOpenLocalWorkspace?: () => void;
  daemonWorkspaces?: WorkspaceSelectorOption[];
  onSelectDaemonWorkspace?: (workspace: WorkspaceSelectorOption) => void;
  onWorkspacesChange?: (workspaces: ManagedAgentWorkspace[]) => void;
  onSelectSession: (
    sessionId: string | undefined,
    workspaceId?: string,
  ) => void;
  onOpenSession?: (sessionId: string, workspaceId?: string) => void;
  workspaceId?: string;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSessionWorkspaceChange?: (workspaceId: string | null) => void;
  provider: ManagedAgentProvider;
  hostSessionOnly: boolean;
  cancellationEnabled: boolean;
  navigationTarget?: HTMLElement | null;
  archivedNavigationTarget?: HTMLElement | null;
  onArchivedSessionsStatusChange?: (
    status: ManagedArchivedSessionsStatus,
  ) => void;
  interactive: boolean;
  creationSkills?: ManagedCreationSkillsSource;
  navigationActive: boolean;
  navigationSearch: string;
}) {
  const { t, language } = useI18n();
  const recoveryText = useManagedRecoveryText();
  const home = hostSessionOnly || navigationTarget !== undefined;
  const clientId = useMemo(
    () => getManagedClientId(provider.storageKey),
    [provider.storageKey],
  );
  const detail = useManagedSession(provider, clientId, sessionId);
  const summary = detail.summary;
  const worktreeReady =
    !summary?.worktree || summary.worktree.state === 'ready';
  const active = summary && isManagedSessionRunning(summary.phase);
  const recovery = useManagedRecovery(
    provider,
    clientId,
    detail.summary,
    interactive,
    detail.refreshSummary,
  );
  const turnCancel = useManagedTurnCancel(
    provider,
    clientId,
    hostSessionOnly && !cancellationEnabled ? undefined : sessionId,
    detail.summary,
    interactive && (!hostSessionOnly || cancellationEnabled),
    detail.refreshSummary,
  );
  const [handoff, setHandoff] = useState<ManagedRecoveryHandoff>();
  const sessionWorkspaceId =
    sessionId && detail.summary?.sessionId === sessionId
      ? (detail.summary.workspace?.workspaceId ?? null)
      : undefined;
  useEffect(() => {
    if (sessionWorkspaceId !== undefined) {
      onSessionWorkspaceChange?.(sessionWorkspaceId);
    }
  }, [sessionWorkspaceId, onSessionWorkspaceChange]);
  const fileReferences = useManagedFileReferences(
    provider,
    clientId,
    detail.summary &&
      detail.summary.sessionId === sessionId &&
      worktreeReady &&
      detail.summary.capabilities.inputAttachments
      ? detail.summary.workspace
      : undefined,
    sessionId,
  );
  const skills = useManagedSkills(provider, clientId, sessionId);
  const mcp = useManagedMcp(provider, clientId, sessionId, String(interactive));
  const referenceActions = useMemo(
    () =>
      fileReferences.actions || mcp
        ? {
            ...fileReferences.actions,
            ...mcp,
            scopeKey: JSON.stringify([
              fileReferences.actions?.scopeKey,
              mcp?.scopeKey,
            ]),
          }
        : undefined,
    [fileReferences.actions, mcp],
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const taskTriggerRef = useRef<HTMLButtonElement>(null);
  const [wideTasks, setWideTasks] = useState(false);
  const [taskPanelSession, setTaskPanelSession] = useState<string>();
  const taskPanelOpen = !!sessionId && taskPanelSession === sessionId;
  const publicChildren = detail.summary?.capabilities.childAgents === true;
  const tasks = useManagedTasks(
    provider,
    clientId,
    sessionId,
    taskPanelOpen || publicChildren,
  );
  const [childView, setChildView] = useState<{
    provider: ManagedAgentProvider;
    clientId: string;
    root: string;
    child: string;
    trigger: Element | null;
  }>();
  useEffect(() => setChildView(undefined), [provider, clientId, sessionId]);
  const taskSnapshots = useMemo(
    () => (tasks.task ? [...tasks.page.data, tasks.task] : tasks.page.data),
    [tasks.page.data, tasks.task],
  );
  const taskCancel = useManagedTaskCancel(
    provider,
    clientId,
    sessionId,
    taskSnapshots,
    tasks.refresh,
    tasks.apply,
  );
  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const resize = () =>
      setWideTasks(element.getBoundingClientRect().width >= 1100);
    resize();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(resize)
        : undefined;
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);
  useEffect(() => setTaskPanelSession(undefined), [provider, sessionId]);
  const [sessions, setSessions] = useState<ManagedAgentSessionSummary[]>([]);
  const [archivedSummaries, setArchivedSummaries] = useState<
    ManagedAgentSessionSummary[]
  >([]);
  const [standaloneArchiveState, setArchiveState] = useState<
    'unarchived' | 'archived'
  >('unarchived');
  const archiveState = home ? 'unarchived' : standaloneArchiveState;
  const [titleQuery, setTitleQuery] = useState('');
  const [confirmation, setConfirmation] = useState<{
    session: ManagedAgentSessionSummary;
    action: ManagedLifecycleAction;
  }>();
  const [exporting, setExporting] = useState<Record<string, boolean>>({});
  const exports = useRef(new Map<string, AbortController>());
  useEffect(() => {
    setExporting({});
    const requests = exports.current;
    return () => {
      for (const abort of requests.values()) abort.abort();
      requests.clear();
    };
  }, [provider]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [listLoading, setListLoading] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const rename = useManagedSessionRename(
    provider,
    clientId,
    sessionId,
    detail.summary,
    interactive,
    (renamedSessionId, displayName) => {
      detail.applyTitle(renamedSessionId, displayName);
      listLifetime.current?.abort();
      setSessions((current) =>
        current.map((session) =>
          session.sessionId === renamedSessionId
            ? { ...session, title: displayName }
            : session,
        ),
      );
      setListRevision((current) => current + 1);
    },
  );
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [discarded, setDiscarded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const userMessages = useManagedUserMessages(
    provider,
    interactive ? sessionId : undefined,
  );
  const [pendingRestoreFailed, setPendingRestoreFailed] = useState(false);
  const [outputTarget, setOutputTarget] = useState<{
    sessionId: string;
    itemId?: string;
  }>();
  useEffect(() => setOutputTarget(undefined), [provider, sessionId]);
  useEffect(() => {
    if (detail.summary && !detail.summary.capabilities.artifacts)
      setOutputTarget(undefined);
  }, [detail.summary]);
  const loadToolDetails = useMemo<ToolDetailsLoader | undefined>(() => {
    const reader = provider.toolDetails;
    if (!sessionId || !reader) return undefined;
    return async (callId, signal) => {
      const itemId = callId.slice(callId.lastIndexOf(':') + 1);
      const detail = await reader.get(sessionId, itemId, { clientId, signal });
      return {
        args: detail.input ?? undefined,
        rawOutput:
          detail.shellResult ??
          (detail.output === null
            ? undefined
            : detail.output +
              (detail.truncated ? `\n${t('managed.truncated')}` : '')),
      };
    };
  }, [provider, sessionId, clientId, t]);
  const openResult = useCallback(
    (itemId: string) => {
      if (sessionId) setOutputTarget({ sessionId, itemId });
    },
    [sessionId],
  );
  const pendingKey = `qwen-managed-pending:${provider.storageKey}:${clientId}${hostSessionOnly ? `:host:${sessionId ?? ''}` : ''}`;
  const [pending, setPending] = useState<PendingPrompt | undefined>(() =>
    readPending(pendingKey),
  );
  // 未确认记录仍按原 client key 保存；切会话只改变展示归属，不能覆盖或重放别人的请求。
  const pendingHere = pending?.sessionId === sessionId ? pending : undefined;
  const pendingElsewhere = pending !== undefined && pendingHere === undefined;
  const pendingRef = useRef(pending);
  const encoding = useRef(false);
  const focusComposer = useRef<{ sessionId: string | undefined } | undefined>(
    undefined,
  );
  const composerRef = useRef<EditorHandle | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const composerCommit = useRef<ComposerSubmitCommit | undefined>(undefined);
  const sessionsNavRef = useRef<HTMLElement | null>(null);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const listLifetime = useRef<AbortController | undefined>(undefined);
  const listBusy = useRef(false);
  const selection = useRef(sessionId);
  selection.current = sessionId;
  const navigationSummaries = useMemo(
    () => [
      ...new Map(
        [...sessions, ...(detail.summary ? [detail.summary] : [])].map(
          (session) => [session.sessionId, session],
        ),
      ).values(),
    ],
    [sessions, detail.summary],
  );
  const lifecycleSummaries = useMemo(
    () => [
      ...new Map(
        [...archivedSummaries, ...navigationSummaries].map((session) => [
          session.sessionId,
          session,
        ]),
      ).values(),
    ],
    [archivedSummaries, navigationSummaries],
  );
  const lifecycle = useManagedSessionLifecycle(
    provider,
    clientId,
    lifecycleSummaries,
    (id, action, targetWorkspace) => {
      setListRevision((value) => value + 1);
      if (selection.current !== id) return;
      if (
        action === 'delete' ||
        action === 'archive' ||
        action === 'close_archive'
      ) {
        onSelectSession(undefined, targetWorkspace);
      } else if (action === 'unarchive') {
        setArchiveState('unarchived');
        onSelectSession(id, targetWorkspace);
        detail.reload();
      } else detail.reload();
    },
  );
  function lifecycleAction(
    session: ManagedAgentSessionSummary,
    action: ManagedLifecycleAction,
  ) {
    if (['close', 'close_archive', 'delete'].includes(action))
      setConfirmation({ session, action });
    else lifecycle.start(session, action);
  }
  async function exportSession(id: string, format: 'html' | 'md') {
    if (exports.current.has(id)) return;
    const abort = new AbortController();
    exports.current.set(id, abort);
    setExporting((value) => ({ ...value, [id]: true }));
    try {
      await downloadManagedSession(
        provider,
        clientId,
        id,
        format,
        abort.signal,
      );
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(
          t(
            failure instanceof Error && failure.message === 'export_not_ready'
              ? 'managed.exportNotReady'
              : failure instanceof Error &&
                  failure.message === 'export_too_large'
                ? 'managed.exportTooLarge'
                : failure instanceof Error &&
                    (failure.message === 'invalid_export_snapshot' ||
                      failure.message.includes('cursor_expired') ||
                      (failure instanceof JavaManagedAgentHttpError &&
                        failure.code === 'cursor_expired'))
                  ? 'managed.exportChanged'
                  : 'managed.exportFailed',
          ),
        );
    } finally {
      if (!abort.signal.aborted) {
        exports.current.delete(id);
        setExporting((value) => ({ ...value, [id]: false }));
      }
    }
  }
  const sessionActions = (
    session: ManagedAgentSessionSummary,
    sidebar = false,
  ) => (
    <ManagedSessionActions
      session={session}
      sidebar={sidebar}
      lifecycle={Boolean(provider.lifecycle)}
      state={lifecycle.states[session.sessionId]}
      exporting={exporting[session.sessionId]}
      onAction={lifecycleAction}
      onConfirm={lifecycle.confirm}
      onRename={
        sidebar &&
        interactive &&
        provider.renameSession &&
        session.capabilities.canRename === true
          ? () => rename.open(session)
          : undefined
      }
      onExport={
        provider.exportSnapshot
          ? (id, format) => void exportSession(id, format)
          : undefined
      }
    />
  );
  const messageProjector = useMemo(
    () => createManagedMessageProjector(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- provider and sessionId are projector cache reset keys
    [provider, sessionId],
  );
  const truncatedLabel = t('managed.truncated');
  const messages = useMemo(
    () => messageProjector(detail.events, truncatedLabel),
    [messageProjector, detail.events, truncatedLabel],
  );
  const latestSuccessfulTodos = useMemo(
    () => getLatestSuccessfulTodos(messages),
    [messages],
  );
  // The caveat sits beside the card rather than inside the panel, so the panel
  // is told about it: without this the dialog describes only the tool name and
  // a screen-reader user confirms an approval whose arguments are missing.
  const argumentsCaveatId = useId();
  const answerNoticeId = useId();
  const approvals = useManagedActions(
    provider,
    sessionId,
    clientId,
    // Unknown while the summary reloads, so the shown approval is kept.
    detail.summary ? detail.summary.capabilities.actions === true : undefined,
    detail.events,
    publicChildren,
  );
  const childApprovalSessions = useMemo(
    () =>
      new Set(
        approvals.actions
          .filter((action) => action.sessionId !== sessionId)
          .map((action) => action.sessionId),
      ),
    [approvals.actions, sessionId],
  );
  const pendingApproval = useMemo(
    () =>
      approvals.action
        ? toManagedPermissionRequest(
            approvals.action,
            approvals.action.sessionId === sessionId ? messages : [],
          )
        : null,
    [approvals.action, messages, sessionId],
  );
  const modelChange = useManagedModelChange(
    provider,
    clientId,
    sessionId,
    detail.summary,
    detail.refreshSummary,
    interactive,
  );
  const approvalChange = useManagedApprovalChange(
    provider,
    clientId,
    sessionId,
    detail.summary,
    detail.refreshSummary,
    interactive,
  );
  const compression = useManagedContextCompression(
    provider,
    clientId,
    sessionId,
    detail.summary,
    detail.refreshSummary,
    () =>
      interactive &&
      !busy &&
      !encoding.current &&
      !detail.loading &&
      !pendingRef.current &&
      !pendingApproval &&
      !modelChange.isBlocked() &&
      !approvalChange.isBlocked() &&
      ['created', 'completed', 'failed', 'cancelled'].includes(
        detail.summary?.phase ?? '',
      ),
  );
  // The reason line below is mounted exactly when this holds, so the dialog can
  // point at it without ever leaving a dangling IDREF. A latch-only render has
  // no `alert` node and no operable option left, so this line is the only place
  // a screen-reader user can hear why the card is dead.
  const answerNoticeShown =
    approvals.answerError !== undefined || approvals.respondForbidden;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setPendingRestoreFailed(false);
    setBusy(true);
    void readManagedPending(pendingKey).then(
      (value) => {
        if (abort.signal.aborted) return;
        const saved = readPending(pendingKey, value);
        pendingRef.current = saved;
        setPending(saved);
        setBusy(false);
      },
      () => {
        if (!abort.signal.aborted) setPendingRestoreFailed(true);
      },
    );
    return () => abort.abort();
  }, [pendingKey]);

  useEffect(() => {
    setError(undefined);
    setDiscarded(false);
  }, [provider, sessionId]);

  // The Discard button unmounts itself, dropping focus to <body>: land it on
  // the composer that just got the draft back. The move must wait for the
  // clear to commit — the textarea is disabled while pending is set — and
  // the composer can still be absent (a workspace-binding creator replaces
  // the form) or disabled (the session cannot send), so fall back to the
  // session list landmark rather than leave the user at <body>. The latch is
  // scoped to the session whose discard armed it, and it dies as soon as
  // focus sits somewhere the discard did not put it: a user who moved on is
  // never pulled back. While the disablement can still lift — the summary
  // unknown, or an admitted Turn gating sends for its whole life — the latch
  // stays armed and retries when the summary changes.
  useEffect(() => {
    if (!interactive) return;
    const armed = focusComposer.current;
    if (!armed || pending) return;
    if (armed.sessionId !== sessionId) {
      focusComposer.current = undefined;
      return;
    }
    const composer = composerContainerRef.current?.querySelector(
      '[contenteditable="true"], textarea:not([disabled])',
    );
    const parked = document.activeElement;
    const ours = parked === document.body || parked === sessionsNavRef.current;
    if (composer) {
      focusComposer.current = undefined;
      if (ours) composerRef.current?.focus();
      return;
    }
    if (!ours) {
      focusComposer.current = undefined;
      return;
    }
    sessionsNavRef.current?.focus();
    // detail.summary is the re-arm trigger: a poll or clean pass lifts the
    // disablement by delivering a new summary without touching the record.
  }, [pending, sessionId, detail.summary, interactive]);

  const listTitleQuery = provider.titleSearch
    ? home
      ? navigationSearch
      : titleQuery
    : '';
  const navigationSessions = listTitleQuery ? sessions : navigationSummaries;
  useEffect(() => {
    if (hostSessionOnly) return;
    const abort = new AbortController();
    listLifetime.current = abort;
    listBusy.current = false;
    setSessions([]);
    setNextCursor(undefined);
    setListLoading(true);
    void provider
      .listSessions({
        clientId,
        ...(provider.lifecycle ? { archiveState } : {}),
        ...(listTitleQuery ? { titleQuery: listTitleQuery } : {}),
        limit: 50,
        signal: abort.signal,
      })
      .then((page) => {
        if (abort.signal.aborted) return;
        setSessions((current) =>
          mergeManagedSessionCatalog(current, page.sessions),
        );
        setNextCursor(page.nextCursor);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setListLoading(false);
      });
    return () => abort.abort();
  }, [
    provider,
    clientId,
    listRevision,
    archiveState,
    listTitleQuery,
    hostSessionOnly,
  ]);

  useEffect(() => {
    const current = detail.summary;
    if (
      !current ||
      current.sessionId !== sessionId ||
      (provider.lifecycle &&
        (current.lifecycleStatus === 'archived') !==
          (archiveState === 'archived'))
    )
      return;
    setSessions((rows) => {
      const previous = rows.find((row) => row.sessionId === current.sessionId);
      if (previous === current) return rows;
      return previous
        ? rows.map((row) =>
            row.sessionId === current.sessionId ? current : row,
          )
        : [...rows, current];
    });
  }, [detail.summary, sessionId, sessions, provider.lifecycle, archiveState]);

  const backgroundSessionIds = JSON.stringify(
    sessions
      .filter(
        (row) =>
          row.sessionId !== sessionId && isManagedSessionRunning(row.phase),
      )
      .map((row) => row.sessionId)
      .sort(),
  );
  useEffect(() => {
    const ids = JSON.parse(backgroundSessionIds) as string[];
    if (!ids.length) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(
        ids.map((id) =>
          provider.getSession(id, { clientId, signal: abort.signal }),
        ),
      );
      if (abort.signal.aborted) return;
      const updates = new Map<string, ManagedAgentSessionSummary>();
      results.forEach((result, index) => {
        if (
          result.status === 'fulfilled' &&
          result.value.sessionId === ids[index]
        ) {
          updates.set(result.value.sessionId, result.value);
        }
      });
      setSessions((rows) =>
        rows.map((row) => {
          const update = updates.get(row.sessionId);
          return update && update.updatedAt >= row.updatedAt ? update : row;
        }),
      );
      timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [provider, clientId, backgroundSessionIds, listRevision]);

  const reloadSession = detail.reload;
  const refresh = useCallback(() => {
    setError(undefined);
    setListRevision((current) => current + 1);
    setWorkspaceRevision((current) => current + 1);
    reloadSession();
  }, [reloadSession]);

  async function loadMore() {
    const abort = listLifetime.current;
    if (!nextCursor || listBusy.current || !abort || abort.signal.aborted)
      return;
    listBusy.current = true;
    setListLoading(true);
    try {
      const page = await provider.listSessions({
        clientId,
        ...(provider.lifecycle ? { archiveState } : {}),
        ...(listTitleQuery ? { titleQuery: listTitleQuery } : {}),
        cursor: nextCursor,
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSessions((current) => [
        ...new Map(
          [
            ...current,
            ...mergeManagedSessionCatalog(current, page.sessions),
          ].map((item) => [item.sessionId, item]),
        ).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) {
        listBusy.current = false;
        setListLoading(false);
      }
    }
  }

  async function submit(
    submittedText = text,
    commit?: ComposerSubmitCommit,
    images?: PromptImage[],
    files?: PromptFile[],
    metadata?: ComposerSubmitMetadata,
  ) {
    const abort = lifetime.current;
    if (
      (hostSessionOnly && !sessionId) ||
      (pendingRef.current && pendingRef.current.sessionId !== sessionId) ||
      !abort ||
      abort.signal.aborted ||
      busy ||
      encoding.current ||
      lifecycle.blocked(sessionId) ||
      modelChange.isBlocked() ||
      approvalChange.isBlocked() ||
      compression.isBlocked()
    )
      return;
    setDiscarded(false);
    let attempt = pendingRef.current;
    const ownerSession = attempt ? attempt.sessionId : sessionId;
    const draftKey = getComposerDraftStorageKey(
      undefined,
      `managed:${provider.storageKey}:${ownerSession ?? 'new'}`,
    );
    const isDraftUnchanged = captureComposerDraftGuard(draftKey);
    if (!attempt) {
      if (
        (!submittedText.trim() && !images?.length && !files?.length) ||
        (sessionId &&
          (!detail.summary?.capabilities.canSend ||
            recovery.value?.nextTurnAllowed === false) &&
          !userMessages.supported)
      )
        return;
      let input: ManagedInputBlock[];
      encoding.current = true;
      setBusy(true);
      try {
        const prepared = await fileReferences.prepareInput(
          submittedText,
          files,
          metadata,
        );
        if (
          userMessages.supported &&
          images?.length &&
          (active ||
            userMessages.snapshot?.messages.length ||
            userMessages.snapshot?.paused)
        )
          throw new Error(t('managed.queue.imagesIdleOnly'));
        input = await encodeManagedInput(prepared.text, images, prepared.files);
        fileReferences.assertCurrent();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return;
      } finally {
        encoding.current = false;
        setBusy(false);
      }
      if (abort.signal.aborted || selection.current !== sessionId) return;
      attempt = {
        idempotencyKey: managedRequestId(),
        queued:
          !!sessionId &&
          userMessages.supported &&
          (!!active ||
            !!userMessages.snapshot?.messages.length ||
            !!userMessages.snapshot?.paused),
        text: submittedText,
        draftText: composerRef.current?.getText(),
        sessionId,
        ...(input.some(
          (block) =>
            block.type !== 'input_text' || block.text !== submittedText,
        )
          ? { input }
          : {}),
      };
      encoding.current = true;
      setBusy(true);
      const persisted = await persistPending(pendingKey, attempt);
      encoding.current = false;
      if (abort.signal.aborted) return;
      if (!persisted) {
        setError(t('managed.workspaceStorageUnavailable'));
        setBusy(false);
        return;
      }
      pendingRef.current = attempt;
      setPending(attempt);
      composerCommit.current = commit;
      if (selection.current !== sessionId) {
        setBusy(false);
        return;
      }
    }
    setBusy(true);
    setError(undefined);
    const selectedAtSubmit = selection.current;
    try {
      const opts = {
        clientId,
        idempotencyKey: attempt.idempotencyKey,
        signal: abort.signal,
      };
      if (attempt.queued && !provider.userMessages)
        throw new Error('User message queue unavailable');
      const admission =
        attempt.sessionId && attempt.queued
          ? await provider
              .userMessages!.command(
                attempt.sessionId,
                {
                  action: 'submit',
                  input: attempt.input ?? [
                    { type: 'input_text', text: attempt.text },
                  ],
                },
                {
                  idempotencyKey: attempt.idempotencyKey,
                  signal: abort.signal,
                },
              )
              .then(() => ({ sessionId: attempt.sessionId! }))
          : attempt.sessionId
            ? await provider.submitPrompt(
                attempt.sessionId,
                {
                  text: attempt.text,
                  ...(attempt.input ? { input: attempt.input } : {}),
                },
                opts,
              )
            : await provider.createSession(
                {
                  text: attempt.text,
                  ...(attempt.input ? { input: attempt.input } : {}),
                },
                opts,
              );
      if (abort.signal.aborted) return;
      if (attempt.queued) void userMessages.refresh();
      pendingRef.current = undefined;
      setPending(undefined);
      await persistPending(pendingKey, undefined);
      if (abort.signal.aborted) return;
      setListRevision((current) => current + 1);
      const clearDraft = isDraftUnchanged();
      composerCommit.current?.();
      composerCommit.current = undefined;
      if (clearDraft)
        for (const draft of [attempt.draftText, attempt.text]) {
          if (draft !== undefined) clearComposerDraftIfMatches(draftKey, draft);
        }
      const editor = composerRef.current;
      if (
        clearDraft &&
        selection.current === attempt.sessionId &&
        editor &&
        [attempt.draftText, attempt.text].includes(editor.getText())
      ) {
        editor.clear();
        setText('');
      }
      if (selection.current === selectedAtSubmit) {
        if (summary?.workspace)
          onSelectSession(admission.sessionId, summary.workspace.workspaceId);
        else onSelectSession(admission.sessionId);
        detail.reload();
      }
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (isNonRetryableClientError(failure)) {
        pendingRef.current = undefined;
        setPending(undefined);
        await persistPending(pendingKey, undefined);
        if (abort.signal.aborted) return;
        if (selection.current === selectedAtSubmit) setText(attempt.text);
        if (selection.current === selectedAtSubmit)
          restoreManagedAttachments(composerRef.current, attempt.input);
      }
      if (selection.current === selectedAtSubmit)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  const attachmentCapability = useRef({ sessionId, enabled: false });
  if (attachmentCapability.current.sessionId !== sessionId)
    attachmentCapability.current = { sessionId, enabled: false };
  if (summary)
    attachmentCapability.current.enabled =
      summary.capabilities.inputAttachments === true && worktreeReady;
  const { request: requestTurnCancel, busy: turnCancelBusy } = turnCancel;
  const failureMessage = summary?.failure
    ? (FAILURE_MESSAGES[summary.failure.code]?.[language === 'zh-CN' ? 1 : 0] ??
      summary.failure.message)
    : undefined;
  const cancel = useCallback(async () => {
    const abort = lifetime.current;
    if (
      !summary?.capabilities.canCancel ||
      !summary.activeTurnId ||
      !cancellationEnabled ||
      busy ||
      turnCancelBusy ||
      !abort ||
      abort.signal.aborted
    )
      return;
    await requestTurnCancel();
  }, [summary, cancellationEnabled, busy, turnCancelBusy, requestTurnCancel]);

  const currentSummary = summary?.sessionId === sessionId ? summary : undefined;
  function prepareHandoff() {
    if (
      !currentSummary ||
      !recovery.value?.actions.continueInNewSession ||
      !provider.workspaceBinding?.createSession
    )
      return;
    const draft = buildManagedRecoveryHandoff(
      { ...currentSummary, recovery: recovery.value },
      detail.events,
      {
        introduction: recoveryText('managed.recovery.handoff.introduction'),
        source: recoveryText('managed.recovery.handoff.source'),
        task: recoveryText('managed.recovery.handoff.task'),
        confirmed: recoveryText('managed.recovery.handoff.confirmed'),
        uncertain: recoveryText('managed.recovery.handoff.uncertain'),
        truncated: recoveryText('managed.recovery.handoff.truncated'),
      },
      Boolean(detail.olderCursor) ||
        detail.loading ||
        detail.events.length === 0,
    );
    setHandoff(draft);
    onSelectSession(undefined, draft.workspaceId);
  }
  const modelContext = currentSummary?.modelContext;
  const selectedModel = currentSummary?.modelSelection?.modelId;
  const displayedModel =
    hostSessionOnly && !modelChange.supported
      ? ''
      : (selectedModel ??
        modelContext?.modelId ??
        (hostSessionOnly ? undefined : currentSummary?.agentId) ??
        '');
  const contextUsageKnown =
    !compression.usageInvalidated &&
    (!selectedModel || modelContext?.modelId === selectedModel) &&
    modelContext?.inputTokens !== undefined &&
    Number.isSafeInteger(modelContext.inputTokens) &&
    modelContext.inputTokens >= 0 &&
    modelContext.contextWindowSize !== undefined &&
    Number.isSafeInteger(modelContext.contextWindowSize) &&
    modelContext.contextWindowSize > 0;
  useEffect(() => {
    if (
      !home ||
      !interactive ||
      pendingApproval ||
      busy ||
      !cancellationEnabled ||
      !summary?.capabilities.canCancel ||
      !summary.activeTurnId
    )
      return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      const target = event.target;
      if (
        !(target instanceof Node) ||
        (target !== document.body && !pageRef.current?.contains(target)) ||
        (target instanceof Element &&
          target.closest('[role="dialog"], [role="alertdialog"]'))
      )
        return;
      event.preventDefault();
      void cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    home,
    interactive,
    pendingApproval,
    busy,
    cancellationEnabled,
    summary,
    cancel,
  ]);
  // Cancel authority differs from submit authority: the creator may stop a
  // running bound Turn after the Workspace stops admitting new work, so the
  // control is not tied to the composer and the server's 409 is the gate.
  const cancelButton =
    cancellationEnabled &&
    summary?.capabilities.canCancel &&
    summary.activeTurnId ? (
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={() => void cancel()}
      >
        {t('managed.cancel')}
      </Button>
    ) : null;
  function openSession(id: string, targetWorkspaceId?: string) {
    const open = onOpenSession ?? onSelectSession;
    if (targetWorkspaceId) open(id, targetWorkspaceId);
    else open(id);
    setText('');
    setError(undefined);
  }

  const navigation = (
    <nav
      ref={sessionsNavRef}
      tabIndex={-1}
      aria-label={t('managed.sessions')}
      className={`flex min-h-0 flex-col gap-1 overflow-y-auto ${home ? '' : 'max-h-48 md:max-h-none'}`}
    >
      {!interactive && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {Object.entries(lifecycle.states).map(([id, state]) => (
        <div
          key={id}
          role="status"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span>
            {lifecycleSummaries.find((session) => session.sessionId === id)
              ?.title || id}
            : {t(`managed.lifecycle.${state.status}`)}
          </span>
          {state.action === 'close_archive' &&
            state.kind === 'archive' &&
            ['failed', 'unconfirmed'].includes(state.status) && (
              <span>{t('managed.lifecycle.archiveIncomplete')}</span>
            )}
          {state.code && (
            <span>
              {state.code === 'turn_active'
                ? t('managed.lifecycle.stopFirst')
                : state.code === 'storage_unavailable'
                  ? t('managed.lifecycle.storageUnavailable')
                  : state.code}
            </span>
          )}
          {state.code === 'turn_active' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (selection.current === id) void cancel();
                else
                  openSession(
                    id,
                    lifecycleSummaries.find(
                      (session) => session.sessionId === id,
                    )?.workspace?.workspaceId,
                  );
              }}
            >
              {t(
                selection.current === id
                  ? 'managed.cancel'
                  : 'managed.lifecycle.openTask',
              )}
            </Button>
          )}
          {state.canConfirm &&
            !state.busy &&
            (state.status !== 'failed' ||
              lifecycleSummaries.some(
                (session) =>
                  session.sessionId === id &&
                  (session.capabilities.sessionClose ||
                    session.capabilities.sessionDelete ||
                    session.capabilities.sessionArchive ||
                    session.capabilities.sessionUnarchive),
              )) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => lifecycle.confirm(id)}
              >
                {t(
                  state.status === 'failed'
                    ? 'managed.lifecycle.retry'
                    : 'managed.lifecycle.confirm',
                )}
              </Button>
            )}
        </div>
      ))}
      {!home && provider.lifecycle && (
        <div className="flex gap-1" aria-label={t('managed.historyFilter')}>
          {(['unarchived', 'archived'] as const).map((state) => (
            <Button
              key={state}
              size="sm"
              variant={archiveState === state ? 'secondary' : 'ghost'}
              aria-pressed={archiveState === state}
              onClick={() => setArchiveState(state)}
            >
              {t(`managed.history.${state}`)}
            </Button>
          ))}
        </div>
      )}
      {!home && provider.titleSearch && (
        <label className="px-2 py-1">
          <span className="sr-only">{t('managed.titleSearch')}</span>
          <Input
            type="search"
            value={titleQuery}
            maxLength={512}
            placeholder={t('managed.titleSearchPlaceholder')}
            aria-label={t('managed.titleSearch')}
            onChange={(event) => setTitleQuery(event.target.value)}
          />
        </label>
      )}
      {home && provider.workspaceBinding ? (
        <ManagedWorkspaceNavigation
          provider={provider}
          clientId={clientId}
          sessions={navigationSessions.filter(
            (session) =>
              !provider.lifecycle ||
              (archiveState === 'archived'
                ? session.lifecycleStatus === 'archived'
                : session.lifecycleStatus !== 'archived'),
          )}
          renderSessionActions={(session) => sessionActions(session, true)}
          sessionId={sessionId}
          workspaceId={workspaceId}
          active={navigationActive}
          search={navigationSearch}
          revision={workspaceRevision}
          onSelectWorkspace={onSelectWorkspace}
          onSelectSession={openSession}
          onWorkspacesChange={onWorkspacesChange}
        />
      ) : (
        sessions
          .filter((session) =>
            `${summary?.sessionId === session.sessionId ? summary.title : session.title} ${session.sessionId}`
              .toLocaleLowerCase()
              .includes(navigationSearch.trim().toLocaleLowerCase()),
          )
          .map((session) => {
            const current =
              summary?.sessionId === session.sessionId ? summary : session;
            if (home) {
              return (
                <ManagedSessionNavigationRow
                  key={session.sessionId}
                  session={current}
                  active={navigationActive && sessionId === session.sessionId}
                  onSelect={() =>
                    openSession(
                      session.sessionId,
                      session.workspace?.workspaceId,
                    )
                  }
                  actions={sessionActions(current, true)}
                />
              );
            }
            return (
              <div
                key={session.sessionId}
                className="flex min-w-0 items-center"
              >
                <Button
                  variant={
                    navigationActive && sessionId === session.sessionId
                      ? 'secondary'
                      : 'ghost'
                  }
                  className="h-auto min-w-0 flex-1 shrink justify-start py-2 text-left"
                  aria-current={
                    navigationActive && sessionId === session.sessionId
                      ? 'page'
                      : undefined
                  }
                  onClick={() =>
                    openSession(
                      session.sessionId,
                      session.workspace?.workspaceId,
                    )
                  }
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {current.title || session.sessionId}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t(
                        current.lifecycleStatus &&
                          current.lifecycleStatus !== 'active'
                          ? `managed.sessionState.${current.lifecycleStatus}`
                          : `managed.phase.${current.phase}`,
                      )}
                    </span>
                  </span>
                </Button>
                {sessionActions(current)}
              </div>
            );
          })
      )}
      {!sessions.length &&
        !listLoading &&
        !(home && provider.workspaceBinding) && (
          <p className="p-2 text-sm text-muted-foreground">
            {t('managed.empty')}
          </p>
        )}
      {listLoading && (
        <p role="status" className="p-2 text-sm">
          {t('managed.loading')}
        </p>
      )}
      {nextCursor && (
        <Button
          variant="ghost"
          aria-label={`${t('managed.more')} ${t('managed.sessions')}`}
          disabled={listLoading}
          onClick={() => void loadMore()}
        >
          {t('managed.more')}
        </Button>
      )}
    </nav>
  );
  if (hostSessionOnly && !sessionId) {
    return (
      <section
        aria-label={t('managed.conversation')}
        data-managed-host-waiting
      />
    );
  }
  return (
    <div
      ref={pageRef}
      className={`flex h-full min-h-0 flex-col ${home ? '' : 'gap-3'}`}
    >
      {/* The uncertain-request row unmounts on the Discard click itself, so
          a persistent region announces the outcome wherever focus lands. */}
      <p role="status" className="sr-only">
        {discarded ? t('managed.discarded') : ''}
      </p>
      {!hostSessionOnly &&
        home &&
        provider.lifecycle &&
        archivedNavigationTarget &&
        createPortal(
          <ManagedArchivedSessions
            key={listRevision}
            provider={provider}
            clientId={clientId}
            sessionId={sessionId}
            active={navigationActive}
            onSelectSession={openSession}
            renderSessionActions={sessionActions}
            onSessionsChange={setArchivedSummaries}
            onStatusChange={onArchivedSessionsStatusChange}
          />,
          archivedNavigationTarget,
        )}
      {confirmation && (
        <ManagedLifecycleConfirmation
          {...confirmation}
          onClose={() => setConfirmation(undefined)}
          onConfirm={() => {
            lifecycle.start(confirmation.session, confirmation.action);
            setConfirmation(undefined);
          }}
        />
      )}
      {rename.editor && (
        <SessionRenameDialog
          value={rename.editor.value}
          busy={rename.editor.busy}
          error={rename.editor.error}
          onChange={rename.setValue}
          onSubmit={(displayName) => void rename.submit(displayName)}
          onClose={rename.close}
        />
      )}
      {!home && (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            onClick={() => {
              onSelectSession(undefined);
              setText('');
              setError(undefined);
            }}
            disabled={busy}
          >
            {t('managed.new')}
          </Button>
          <Button variant="ghost" onClick={refresh}>
            {t('managed.refresh')}
          </Button>
        </div>
      )}
      {/* One server condition can surface through both channels; announce
          each distinct message once, keyed by the message so a standing
          alert keeps its node when a duplicate of it stops rendering. */}
      {[
        ...new Set(
          [detail.stoppedReason, detail.error, error].filter(
            (message): message is string =>
              Boolean(message) &&
              (interactive || message !== error) &&
              // summary.failure 已在会话信息区渲染（下方失败区块），告警通道不再重复。
              message !== failureMessage,
          ),
        ),
      ].map((message) => (
        <p key={message} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ))}
      {pendingRestoreFailed && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            {t('managed.pendingRestoreFailed')}
          </p>
          <Button
            variant="outline"
            onClick={async () => {
              const abort = lifetime.current;
              if (!abort || abort.signal.aborted) return;
              const discarded = await persistPending(pendingKey, undefined);
              if (abort.signal.aborted) return;
              if (!discarded) {
                setError(t('managed.pendingDiscardFailed'));
                return;
              }
              pendingRef.current = undefined;
              setPending(undefined);
              setPendingRestoreFailed(false);
              setBusy(false);
              setError(undefined);
            }}
          >
            {t('managed.discard')}
          </Button>
        </div>
      )}
      <div
        className={`grid min-h-0 flex-1 gap-4 ${home ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]'}`}
        style={
          taskPanelOpen && wideTasks
            ? {
                gridTemplateColumns: home
                  ? 'minmax(0,1fr) 360px'
                  : 'minmax(180px,240px) minmax(0,1fr) 360px',
              }
            : undefined
        }
      >
        {hostSessionOnly
          ? null
          : home
            ? navigationTarget
              ? createPortal(navigation, navigationTarget)
              : null
            : navigation}
        <section
          className={`${shellStyles.chatPane} ${home ? '' : 'gap-3'}`}
          data-managed-home={home || undefined}
          aria-label={t('managed.conversation')}
        >
          {summary && home && (
            <div className="shrink-0">
              <ChatContextHeader
                content={
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate"
                      onDoubleClick={() => rename.open()}
                    >
                      {summary.title === summary.sessionId
                        ? summary.sessionId.slice(0, 8)
                        : summary.title}
                    </span>
                    {sessionActions(summary)}
                  </span>
                }
                workspaceName={summary.workspace?.workspaceId}
                location={
                  <Badge variant="secondary">
                    {t(`managed.phase.${summary.phase}`)}
                    {summary.lifecycleStatus &&
                      summary.lifecycleStatus !== 'active' &&
                      ` · ${t(`managed.sessionState.${summary.lifecycleStatus}`)}`}
                  </Badge>
                }
                environmentOpen={taskPanelOpen}
                environmentAvailable={Boolean(
                  provider.tasks &&
                    (summary.capabilities.tasks ||
                      taskCancel.pendingTaskIds.length),
                )}
                onToggleEnvironment={() =>
                  setTaskPanelSession(taskPanelOpen ? undefined : sessionId)
                }
                rightPanelOpen={Boolean(outputTarget)}
                rightPanelAvailable={Boolean(
                  summary.capabilities.artifacts && provider.toolResults,
                )}
                onToggleRightPanel={() =>
                  setOutputTarget(
                    outputTarget ? undefined : { sessionId: summary.sessionId },
                  )
                }
              />
            </div>
          )}
          {summary && !home && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span
                className="max-w-full break-words font-medium"
                onDoubleClick={() => rename.open()}
              >
                {summary.title}
              </span>
              {rename.supported && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => rename.open()}
                >
                  {t('sidebar.rename')}
                </Button>
              )}
              {provider.tasks &&
                (summary.capabilities.tasks === true ||
                  taskCancel.pendingTaskIds.length > 0) && (
                  <Button
                    ref={taskTriggerRef}
                    variant="outline"
                    size="sm"
                    aria-expanded={taskPanelOpen}
                    onClick={() =>
                      setTaskPanelSession(taskPanelOpen ? undefined : sessionId)
                    }
                  >
                    {t(
                      summary.capabilities.tasks === true
                        ? 'managed.tasks.title'
                        : 'managed.tasks.recovery',
                    )}
                  </Button>
                )}
              {Object.entries(taskCancel.states).map(([taskId, state]) => (
                <span key={taskId} role="status">
                  {t(taskCancelMessage(state))}
                </span>
              ))}
              <Badge variant="secondary">
                {t(`managed.phase.${summary.phase}`)}
              </Badge>
              {summary.phase !== 'created' && (
                <span className="text-muted-foreground">
                  {t('managed.runtime')}:{' '}
                  {t(`managed.runtime.${summary.runtimeState}`)}
                </span>
              )}
              {displayedModel && (
                <span className="text-muted-foreground" data-managed-model>
                  {t('managed.modelPreset')}: {displayedModel}
                </span>
              )}
              {summary.capabilities.artifacts && provider.toolResults && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setOutputTarget({ sessionId: summary.sessionId })
                  }
                >
                  {t('managed.result.outputs')}
                </Button>
              )}
            </div>
          )}
          {home &&
            Object.entries(taskCancel.states).map(([taskId, state]) => (
              <span key={taskId} role="status">
                {t(taskCancelMessage(state))}
              </span>
            ))}
          {summary?.workspace && !home && (
            <div
              className="rounded-md border px-3 py-2 text-sm"
              data-managed-workspace-binding
            >
              <p>
                {t('managed.workspaceBound')}: {summary.workspace.workspaceId}
              </p>
              <p>
                {t('managed.workspaceDirectory')}:{' '}
                {summary.workspace.cwdRelative}
              </p>
              {!summary.capabilities.workspaceTurns && (
                <p className="text-muted-foreground">
                  {t('managed.workspaceExecutionUnavailable')}
                </p>
              )}
            </div>
          )}
          {summary?.worktree &&
            (!home || summary.worktree.state !== 'ready') && (
              <ManagedWorktreeStatus
                worktree={summary.worktree}
                compact={home}
              />
            )}

          {recovery.value && (
            <ManagedRecoveryPanel
              recovery={recovery.value}
              busy={!interactive || recovery.busy || turnCancel.busy}
              error={recovery.error}
              onRecheck={() => void recovery.recheck()}
              onCancel={
                cancellationEnabled && summary?.capabilities.canCancel
                  ? () => void cancel()
                  : undefined
              }
              onHandoff={
                provider.workspaceBinding?.createSession
                  ? prepareHandoff
                  : undefined
              }
            />
          )}
          {turnCancel.status && (
            <div role="status" className="flex items-center gap-2 text-sm">
              <span>
                {recoveryText(`managed.recovery.cancel.${turnCancel.status}`)}
              </span>
              {turnCancel.pending && turnCancel.status === 'unconfirmed' && (
                <Button
                  variant="outline"
                  disabled={!interactive || turnCancel.busy}
                  onClick={() => void turnCancel.retry()}
                >
                  {recoveryText('managed.recovery.recheck')}
                </Button>
              )}
            </div>
          )}
          {provider.workspaceBinding &&
            (!sessionId || workspaceCreationOpen) && (
              <WorkspaceBindingCreator
                key={
                  !sessionId ? (handoff?.sourceSessionId ?? 'new') : 'workspace'
                }
                provider={provider}
                handoff={!sessionId ? handoff : undefined}
                onOpenHandoffSource={
                  handoff
                    ? () =>
                        onSelectSession(
                          handoff.sourceSessionId,
                          handoff.workspaceId,
                        )
                    : undefined
                }
                workspaceCreationOpen={workspaceCreationOpen}
                onWorkspaceCreationOpenChange={onWorkspaceCreationOpenChange}
                onOpenLocalWorkspace={onOpenLocalWorkspace}
                daemonWorkspaces={daemonWorkspaces}
                onSelectDaemonWorkspace={onSelectDaemonWorkspace}
                creationOnly={Boolean(sessionId)}
                clientId={clientId}
                workspaceId={workspaceId}
                onSelectWorkspace={
                  !sessionId
                    ? (onSessionWorkspaceChange ?? onSelectWorkspace)
                    : undefined
                }
                interactive={interactive}
                creationSkills={creationSkills}
                onWorkspaceCreated={(id) => {
                  setWorkspaceRevision((current) => current + 1);
                  onWorkspaceCreated?.(id);
                }}
                onCreated={(createdId, createdWorkspaceId) => {
                  setHandoff(undefined);
                  setListRevision((current) => current + 1);
                  onSelectSession(createdId, createdWorkspaceId);
                }}
                onAbandoned={() => setListRevision((current) => current + 1)}
              />
            )}
          {latestSuccessfulTodos !== undefined &&
            latestSuccessfulTodos.length > 0 && (
              <section
                className="max-h-[35vh] shrink-0 overflow-y-auto rounded-md border px-3 py-2"
                aria-label={t('todo.title')}
                data-managed-todo-list
              >
                <div className="mb-2 text-sm font-medium">
                  {t('todo.title')}
                </div>
                <TodoFullList todos={latestSuccessfulTodos} numbered />
              </section>
            )}
          {sessionId && detail.olderCursor && (
            <p className="text-xs text-muted-foreground">
              {t('managed.todo.loadedWindow')}
            </p>
          )}
          {!(!sessionId && provider.workspaceBinding) && (
            // 空态（未选中会话且无消息）时内容收缩，由 chatPane 垂直居中，
            // 与 standalone 空态（.appChatEmpty .content { flex: 0 0 auto }）布局一致；
            // 有会话/消息时保持铺满。注意 inline style 优先级高于样式表，不能写死。
            <div
              className={shellStyles.content}
              style={{
                flex:
                  !sessionId && messages.length === 0 ? '0 0 auto' : '1 1 auto',
              }}
            >
              <ToolDetailsContext.Provider value={loadToolDetails}>
                <MessageList
                  messages={messages}
                  onToolResultOpen={
                    summary?.capabilities.artifacts && provider.toolResults
                      ? openResult
                      : undefined
                  }
                  pendingApproval={pendingApproval}
                  sessionKey={`managed:${provider.storageKey}:${sessionId ?? 'new'}`}
                  loadingTranscript={detail.loading}
                  isResponding={Boolean(active)}
                  activeTurnStartedAt={active ? summary?.admittedAt : undefined}
                  hasOlderHistory={Boolean(detail.olderCursor)}
                  loadingOlderHistory={detail.loadingOlder}
                  onLoadOlderHistory={detail.loadOlder}
                  hideSessionTimeline
                  // 空转录仍显示欢迎头；但当会话已有失败态（如服务端已删除）时，
                  // 由 failure 横幅说明状态，不再叠欢迎文案。
                  welcomeHeader={
                    messages.length === 0 &&
                    !detail.loading &&
                    !summary?.failure ? (
                      <WelcomeHeader
                        version=""
                        cwd=""
                        currentModel={displayedModel}
                        currentMode=""
                      />
                    ) : undefined
                  }
                />
              </ToolDetailsContext.Provider>
            </div>
          )}
          {/* 会话级状态统一在 composer 上方透出（与 renderComposerHeader 的位置一致），
              失败与未决提交同区相邻，不再散落在会话信息区。 */}
          {summary?.failure && (
            <div
              role="alert"
              className="mx-auto mb-2 flex w-full max-w-[var(--chat-shell-width)] items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-[10px] text-xs leading-relaxed text-destructive"
            >
              <span aria-hidden="true" className="mt-0.5 shrink-0">
                ⚠
              </span>
              <p className="min-w-0 flex-1">{failureMessage}</p>
            </div>
          )}
          {pendingElsewhere && !busy && (
            <div
              role="status"
              className="mb-2 flex items-center gap-3 text-sm text-muted-foreground"
            >
              <p>{t('managed.pendingElsewhere')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSelectSession(pending?.sessionId)}
              >
                {t('managed.openPendingOwner')}
              </Button>
            </div>
          )}
          {pendingHere && !busy && (
            <div
              role="status"
              className="mx-auto mb-2 flex w-full max-w-[var(--chat-shell-width)] items-start justify-between gap-3 rounded-lg border bg-muted/40 px-3 py-[10px] text-xs leading-relaxed text-muted-foreground"
            >
              <p className="min-w-0 flex-1">{t('managed.uncertain')}</p>
              <Button
                size="sm"
                disabled={busy || compression.blocked}
                onClick={() => void submit()}
              >
                {t('managed.retry')}
              </Button>
              {/* Offered only where the handler can restore the draft:
                  destroying the only copy from a foreign session would lose
                  it for good. */}
              {pendingHere.sessionId === sessionId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    // An escape from a permanently failing retry: reuse the
                    // draft text without minting a new idempotency key.
                    pendingRef.current = undefined;
                    setPending(undefined);
                    void persistPending(pendingKey, undefined);
                    // The pending record is client-scoped but the draft
                    // belongs to the session it was written for: restore it
                    // only there.
                    if (pendingHere.sessionId === sessionId) {
                      setText(pendingHere.text);
                      composerRef.current?.setText(pendingHere.text);
                      restoreManagedAttachments(
                        composerRef.current,
                        pendingHere.input,
                      );
                    }
                    composerCommit.current = undefined;
                    setError(undefined);
                    // A create that committed server-side before an
                    // unconfirmed failure is otherwise invisible until the
                    // user happens to press Refresh.
                    if (pendingHere.sessionId === undefined)
                      setListRevision((current) => current + 1);
                    focusComposer.current = { sessionId };
                    setDiscarded(true);
                  }}
                >
                  {t('managed.discard')}
                </Button>
              )}
            </div>
          )}
          {pendingApproval && (
            <div
              className={home ? shellStyles.footer : 'shrink-0'}
              data-testid="managed-approval"
            >
              {approvals.action?.sessionId !== sessionId && (
                <p className="mb-2 text-sm font-medium">
                  {t('managed.tasks.childApproval')} ·{' '}
                  {approvals.action?.sessionId}
                </p>
              )}
              <ToolApproval
                request={pendingApproval}
                planExecutionMode={
                  approvals.action?.sessionId === sessionId &&
                  approvals.action?.toolName === 'exit_plan_mode' &&
                  approvals.action.turnId === detail.summary?.activeTurnId
                    ? detail.summary?.approvalMode
                    : undefined
                }
                variant="floating"
                keyboardActive={false}
                // Answering needs the Session's owner or a Workspace
                // operator; once the service refuses this viewer, that
                // holds for every approval this Session raises — until an
                // explicit retry re-probes, so the latch is scoped to the
                // Session rather than the Action.
                disabled={approvals.respondForbidden || compression.blocked}
                extraDescriptionId={
                  [
                    pendingApproval.rawInput === undefined
                      ? argumentsCaveatId
                      : null,
                    answerNoticeShown ? answerNoticeId : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                onConfirm={(actionId, optionId) => {
                  if (!compression.isBlocked())
                    return approvals.respond(actionId, optionId);
                  return Promise.resolve();
                }}
              />
              {pendingApproval.rawInput === undefined && (
                <p
                  id={argumentsCaveatId}
                  role="status"
                  className="text-sm text-muted-foreground"
                >
                  {approvals.action?.inputPreview
                    ? t(
                        approvals.action.inputPreview.truncated
                          ? 'managed.approval.previewTruncated'
                          : 'managed.approval.previewComplete',
                        { bytes: approvals.action.inputPreview.byteLength },
                      )
                    : t('managed.approval.argumentsUnavailable')}
                </p>
              )}
            </div>
          )}
          {approvals.loadError !== undefined && (
            <div
              role="alert"
              className="flex items-center gap-2 text-sm text-destructive"
            >
              <span>
                {t(
                  approvals.loaded
                    ? 'managed.approval.refreshFailed'
                    : 'managed.approval.loadFailed',
                )}
              </span>
              <Button variant="outline" size="sm" onClick={approvals.retry}>
                {t('managed.approval.retry')}
              </Button>
            </div>
          )}
          {/* `answerError` is only exposed for the Action on screen, so this
              guard only bounds the latch: the reason describes a card, and
              once the Session has none there is nothing left to explain. */}
          {pendingApproval !== null && answerNoticeShown && (
            <div className="flex items-center gap-2">
              <p
                id={answerNoticeId}
                // The first refusal is news; the latch that keeps every
                // later approval of this Session disabled only restates it,
                // so it is a status line rather than a second alert.
                role={approvals.answerError !== undefined ? 'alert' : 'status'}
                className="text-sm text-destructive"
              >
                {t(
                  approvals.respondForbidden
                    ? 'managed.approval.forbidden'
                    : 'managed.approval.failed',
                )}
              </p>
              {approvals.respondForbidden && (
                // The refusal came from the viewer's role row, which an
                // operator can raise while the page stays open — unlike the
                // load-error retry this renders without a `loadError`.
                <Button variant="outline" size="sm" onClick={approvals.retry}>
                  {t('managed.approval.retry')}
                </Button>
              )}
            </div>
          )}
          <div className={home ? shellStyles.footer : undefined}>
            <ManagedSessionProgress
              summary={summary}
              submitting={
                busy && Boolean(pending) && pending?.sessionId === sessionId
              }
              loading={detail.loading}
            />
          </div>
          {(!hostSessionOnly || !!sessionId) &&
          (hostSessionOnly ||
            !summary?.workspace ||
            summary.capabilities.workspaceTurns) &&
          (!provider.workspaceBinding || (sessionId && summary)) ? (
            <div
              ref={composerContainerRef}
              className={`${shellStyles.footer} flex flex-col gap-2`}
            >
              {fileReferences.error && (
                <p role="alert">{fileReferences.error}</p>
              )}
              <ChatEditor
                key={`${provider.storageKey}:${sessionId ?? 'new'}`}
                ref={composerRef}
                composerScopeKey={`managed:${provider.storageKey}:${sessionId ?? 'new'}`}
                disableLegacyHistoryFallback
                shellModeEnabled={false}
                composerInput={
                  pending && pending.sessionId === sessionId
                    ? { text: pending.text }
                    : undefined
                }
                composerInputVersion={0}
                onInputTextChange={setText}
                onSubmit={(value, images, files, commit, metadata) => {
                  void submit(value, commit, images, files, metadata);
                  return false;
                }}
                commands={skills.commands}
                skills={skills.skills}
                onSkillsOpenChange={
                  skills.supported ? skills.onOpenChange : undefined
                }
                skillsLoading={skills.loading}
                skillsLoadError={skills.error}
                skillsLoaded={skills.loaded}
                workspaceFeaturesEnabled={false}
                fileReferenceActions={referenceActions}
                fileUploadTarget={fileReferences.uploadTarget}
                persistFileReferences
                attachmentsEnabled={
                  attachmentCapability.current.enabled && !active
                }
                visibleToolbarActions={
                  interactive
                    ? [
                        ...(summary?.capabilities.inputAttachments ||
                        referenceActions ||
                        summary?.planModeSupported ||
                        skills.supported
                          ? ['addMenu' as const]
                          : []),
                        ...(summary?.planModeSupported || summary?.planMode
                          ? ['plan' as const]
                          : []),
                        ...(summary?.approvalMode
                          ? ['approvalMode' as const]
                          : []),
                        ...(displayedModel ? ['model' as const] : []),
                        ...(sessionId ? ['contextUsage' as const] : []),
                      ]
                    : []
                }
                currentModel={displayedModel}
                availableModels={
                  modelChange.options?.supported
                    ? modelChange.options.models.map((model) => ({
                        id: model.modelId,
                        label: model.label,
                      }))
                    : displayedModel
                      ? [{ id: displayedModel, label: displayedModel }]
                      : []
                }
                modelControlsDisabled={
                  !interactive ||
                  !modelChange.supported ||
                  !modelChange.options?.supported ||
                  modelChange.optionsLoading ||
                  modelChange.busy ||
                  approvalChange.busy ||
                  modelChange.blocked ||
                  approvalChange.blocked ||
                  compression.blocked ||
                  busy ||
                  Boolean(active) ||
                  Boolean(pendingApproval) ||
                  Boolean(pending) ||
                  modelChange.options.modelSelection.revision !==
                    (currentSummary?.modelSelection?.revision ?? 0)
                }
                onSelectModel={
                  modelChange.supported
                    ? (modelId) => {
                        if (
                          !interactive ||
                          busy ||
                          encoding.current ||
                          pendingRef.current ||
                          active ||
                          pendingApproval ||
                          approvalChange.isBlocked() ||
                          compression.isBlocked()
                        )
                          return;
                        void modelChange.submit(modelId);
                      }
                    : undefined
                }
                tokenCount={contextUsageKnown ? modelContext!.inputTokens : 0}
                contextWindow={
                  contextUsageKnown ? modelContext!.contextWindowSize : 0
                }
                contextUsageKnown={contextUsageKnown}
                contextUsageAlwaysVisible={Boolean(sessionId)}
                contextUsageControls={
                  interactive ? compression.controls : undefined
                }
                currentMode={summary?.approvalMode ?? ''}
                planMode={summary?.planMode === true}
                planControlsDisabled={
                  !interactive ||
                  !approvalChange.supported ||
                  !approvalChange.options?.supported ||
                  approvalChange.optionsLoading ||
                  approvalChange.isBlocked() ||
                  compression.isBlocked() ||
                  busy ||
                  Boolean(active) ||
                  Boolean(pendingApproval) ||
                  Boolean(pending) ||
                  modelChange.isBlocked() ||
                  approvalChange.options.approvalRevision !==
                    (summary?.approvalRevision ?? 0)
                }
                onTogglePlan={
                  summary?.planModeSupported && summary.approvalMode
                    ? () => {
                        if (
                          !busy &&
                          !encoding.current &&
                          !active &&
                          !pendingApproval &&
                          !pendingRef.current &&
                          !modelChange.isBlocked() &&
                          !compression.isBlocked()
                        )
                          void approvalChange.submit(
                            summary.approvalMode!,
                            !summary.planMode,
                          );
                      }
                    : undefined
                }
                availableModes={
                  approvalChange.options?.availableApprovalModes ??
                  (summary?.approvalMode ? [summary.approvalMode] : [])
                }
                modeControlsDisabled={
                  !interactive ||
                  !approvalChange.supported ||
                  !approvalChange.options?.supported ||
                  approvalChange.optionsLoading ||
                  approvalChange.busy ||
                  approvalChange.blocked ||
                  compression.blocked ||
                  busy ||
                  ((Boolean(active) || Boolean(pendingApproval)) &&
                    !approvalChange.options.liveSupported) ||
                  summary?.phase === 'cancelling' ||
                  Boolean(pending) ||
                  modelChange.blocked ||
                  modelChange.busy ||
                  approvalChange.options.approvalRevision !==
                    (summary?.approvalRevision ?? 0)
                }
                onSelectMode={
                  approvalChange.supported
                    ? (mode) => {
                        if (
                          !interactive ||
                          busy ||
                          encoding.current ||
                          pendingRef.current ||
                          ((active || pendingApproval) &&
                            !approvalChange.options?.liveSupported) ||
                          summary?.phase === 'cancelling' ||
                          modelChange.isBlocked() ||
                          compression.isBlocked()
                        )
                          return;
                        if (
                          mode === 'default' ||
                          mode === 'auto-edit' ||
                          mode === 'auto' ||
                          mode === 'yolo'
                        )
                          void approvalChange.submit(mode);
                      }
                    : undefined
                }
                showChatWidthToggle={false}
                isPreparing={
                  busy ||
                  fileReferences.busy ||
                  compression.blocked ||
                  modelChange.busy ||
                  approvalChange.busy
                }
                dialogOpen={!interactive}
                isRunning={
                  home &&
                  Boolean(active || summary?.capabilities.canCancel) &&
                  (!hostSessionOnly ||
                    Boolean(
                      cancellationEnabled &&
                        summary?.capabilities.canCancel &&
                        summary.activeTurnId,
                    ))
                }
                onCancel={
                  home &&
                  cancellationEnabled &&
                  summary?.capabilities.canCancel &&
                  summary.activeTurnId
                    ? () => void cancel()
                    : undefined
                }
                disabled={
                  !interactive ||
                  busy ||
                  Boolean(pending) ||
                  lifecycle.blocked(sessionId) ||
                  modelChange.blocked ||
                  compression.blocked ||
                  approvalChange.blocked ||
                  Boolean(
                    sessionId &&
                      (!summary?.capabilities.canSend ||
                        recovery.value?.nextTurnAllowed === false) &&
                      !userMessages.supported,
                  )
                }
                placeholderText={t(
                  active && userMessages.supported
                    ? 'managed.queue.placeholder'
                    : 'managed.prompt',
                )}
              />
              {userMessages.snapshot && (
                <ManagedUserMessageQueue
                  key={sessionId}
                  snapshot={userMessages.snapshot}
                  command={userMessages.command}
                />
              )}
              {interactive && compression.blocked && (
                <div
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  role="status"
                >
                  <span>
                    {t(
                      compression.errorCode === 'recovery_blocked'
                        ? 'managed.compression.recoveryBlocked'
                        : compression.busy
                          ? 'contextUsage.compressing'
                          : 'managed.compression.unconfirmed',
                    )}
                  </span>
                  {!compression.busy && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!provider.contextCompression}
                      onClick={() => void compression.confirm()}
                    >
                      {t('managed.compression.confirm')}
                    </Button>
                  )}
                </div>
              )}
              {interactive && compression.errorCode && !compression.blocked && (
                <p className="text-xs text-destructive" role="alert">
                  {t(
                    compression.errorCode === 'storage_unavailable'
                      ? 'managed.compression.storage'
                      : compression.errorCode === 'storage_update_failed'
                        ? 'managed.compression.storageUpdate'
                        : compression.errorCode ===
                            'compaction_revision_conflict'
                          ? 'managed.compression.conflict'
                          : compression.errorCode === 'session_context_busy'
                            ? 'managed.compression.busy'
                            : 'contextUsage.compressFailed',
                  )}
                </p>
              )}
              {interactive &&
                (modelChange.busy ||
                  modelChange.blocked ||
                  modelChange.optionsLoading ||
                  modelChange.optionsError) && (
                  <div
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    <span>
                      {t(
                        modelChange.busy
                          ? 'managed.model.changing'
                          : modelChange.blocked
                            ? 'managed.model.unconfirmed'
                            : modelChange.optionsLoading
                              ? 'managed.model.loading'
                              : 'managed.model.optionsError',
                      )}
                    </span>
                    {modelChange.pending && (
                      <span>{modelChange.pending.modelId}</span>
                    )}
                    {modelChange.blocked && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={modelChange.busy || !provider.modelChange}
                        onClick={() => void modelChange.confirm()}
                      >
                        {t('managed.model.confirm')}
                      </Button>
                    )}
                    {modelChange.optionsError && !modelChange.blocked && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={modelChange.reloadOptions}
                      >
                        {t('managed.model.reload')}
                      </Button>
                    )}
                  </div>
                )}
              {interactive &&
                modelChange.errorCode &&
                modelChange.errorCode !== 'unconfirmed' && (
                  <p className="text-xs text-destructive" role="alert">
                    {t(
                      modelChange.errorCode === 'storage_unavailable'
                        ? 'managed.model.storage'
                        : modelChange.errorCode === 'model_selection_conflict'
                          ? 'managed.model.conflict'
                          : ['turn_active', 'session_context_busy'].includes(
                                modelChange.errorCode,
                              )
                            ? 'managed.model.busy'
                            : 'managed.model.failed',
                    )}
                  </p>
                )}
              {interactive &&
                approvalChange.options?.permissionRulesSupported && (
                  <ManagedPermissionRulesDialog
                    key={`permission-rules:${provider.storageKey}:${sessionId}`}
                    rules={approvalChange.options.permissionRules}
                    revision={approvalChange.options.approvalRevision}
                    busy={approvalChange.busy}
                    errorCode={approvalChange.errorCode}
                    disabled={
                      !approvalChange.options.supported ||
                      approvalChange.optionsLoading ||
                      approvalChange.isBlocked() ||
                      compression.isBlocked() ||
                      modelChange.isBlocked() ||
                      busy ||
                      Boolean(active) ||
                      Boolean(pendingApproval) ||
                      Boolean(pending) ||
                      approvalChange.options.approvalRevision !==
                        (summary?.approvalRevision ?? 0)
                    }
                    onSave={(rules) =>
                      summary?.approvalMode
                        ? approvalChange.submit(
                            summary.approvalMode,
                            undefined,
                            rules,
                          )
                        : Promise.resolve(undefined)
                    }
                  />
                )}
              {interactive &&
                (approvalChange.busy ||
                  approvalChange.blocked ||
                  approvalChange.optionsLoading ||
                  approvalChange.optionsError) && (
                  <div
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    <span>
                      {t(
                        approvalChange.busy
                          ? 'managed.approvalChange.changing'
                          : approvalChange.blocked
                            ? 'managed.approvalChange.unconfirmed'
                            : approvalChange.optionsLoading
                              ? 'managed.approvalChange.loading'
                              : 'managed.approvalChange.optionsError',
                      )}
                    </span>
                    {approvalChange.pending && (
                      <span>{approvalChange.pending.approvalMode}</span>
                    )}
                    {approvalChange.blocked && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          approvalChange.busy || !provider.approvalChange
                        }
                        onClick={() => void approvalChange.confirm()}
                      >
                        {t('managed.approvalChange.confirm')}
                      </Button>
                    )}
                    {approvalChange.optionsError && !approvalChange.blocked && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={approvalChange.reloadOptions}
                      >
                        {t('managed.approvalChange.reload')}
                      </Button>
                    )}
                  </div>
                )}
              {interactive &&
                approvalChange.errorCode &&
                approvalChange.errorCode !== 'unconfirmed' && (
                  <p className="text-xs text-destructive" role="alert">
                    {t(
                      approvalChange.errorCode === 'storage_unavailable'
                        ? 'managed.approvalChange.storage'
                        : approvalChange.errorCode ===
                            'approval_selection_conflict'
                          ? 'managed.approvalChange.conflict'
                          : ['turn_active', 'session_context_busy'].includes(
                                approvalChange.errorCode,
                              )
                            ? 'managed.approvalChange.busy'
                            : 'managed.approvalChange.failed',
                    )}
                  </p>
                )}
              {displayedModel && !modelChange.supported && (
                <p className="text-xs text-muted-foreground">
                  {t('managed.modelFixed')}
                </p>
              )}
              {summary?.approvalMode && !approvalChange.supported && (
                <p className="text-xs text-muted-foreground">
                  {t('managed.approvalFixed')}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                {sessionId &&
                  !active &&
                  summary &&
                  !summary.capabilities.canSend && (
                    <span className="mr-auto text-sm text-muted-foreground">
                      {t('managed.newRequired')}
                    </span>
                  )}
                {(!home || Boolean(text.trim())) && cancelButton}
              </div>
            </div>
          ) : (
            cancelButton && (
              <div className="flex shrink-0 justify-end">{cancelButton}</div>
            )
          )}
          {interactive &&
            outputTarget &&
            outputTarget.sessionId === sessionId &&
            sessionId &&
            (!summary || summary.capabilities.artifacts) &&
            provider.toolResults && (
              <ManagedToolResultPanel
                key={`${sessionId}:${outputTarget.itemId ?? 'all'}`}
                reader={provider.toolResults}
                sessionId={sessionId}
                clientId={clientId}
                itemId={outputTarget.itemId}
                onClose={() => setOutputTarget(undefined)}
              />
            )}
        </section>
        {interactive && taskPanelOpen && sessionId && provider.tasks && (
          <ManagedTaskPanel
            key={`${provider.storageKey}:${sessionId}`}
            wide={wideTasks}
            tasks={tasks}
            waitingSessions={childApprovalSessions}
            onOpenChild={(child) =>
              setChildView({
                provider,
                clientId,
                root: sessionId,
                child,
                trigger: document.activeElement,
              })
            }
            cancel={taskCancel}
            canCancel={
              summary?.capabilities.tasks === true && !!provider.tasks.cancel
            }
            reader={
              summary?.capabilities.artifacts === true
                ? provider.toolResults
                : undefined
            }
            clientId={clientId}
            sessionId={sessionId}
            onClose={() => setTaskPanelSession(undefined)}
            restoreFocus={() => {
              if (taskTriggerRef.current?.isConnected)
                taskTriggerRef.current.focus();
              else sessionsNavRef.current?.focus();
            }}
          />
        )}
        {childView &&
          childView.provider === provider &&
          childView.clientId === clientId &&
          childView.root === sessionId && (
            <ManagedChildSessionView
              key={`${provider.storageKey}:${sessionId}:${childView.child}`}
              provider={provider}
              clientId={clientId}
              sessionId={childView.child}
              onClose={() => setChildView(undefined)}
              restoreFocus={() => {
                if (
                  childView.trigger instanceof HTMLElement &&
                  childView.trigger.isConnected
                )
                  childView.trigger.focus();
                else taskTriggerRef.current?.focus();
              }}
            />
          )}
      </div>
    </div>
  );
}

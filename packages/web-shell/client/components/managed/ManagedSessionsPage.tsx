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
import shellStyles from '../../App.module.css';
import { MessageList } from '../MessageList';
import { ChatEditor } from '../ChatEditor';
import { WelcomeHeader } from '../WelcomeHeader';
import { ChatContextHeader } from '../ChatContextHeader';
import type {
  EditorHandle,
  ComposerSubmitCommit,
} from '../../hooks/useComposerCore';
import {
  clearComposerDraftIfMatches,
  getComposerDraftStorageKey,
} from '../../hooks/useComposerCore';
import { ToolApproval } from '../messages/ToolApproval';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { managedEventsToMessages } from './managed-session-messages';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';
import { useManagedSession } from './use-managed-session';
import { useManagedActions } from './use-managed-actions';
import { useManagedCwdChange } from './use-managed-cwd-change';
import { useManagedModelChange } from './use-managed-model-change';
import { useManagedApprovalChange } from './use-managed-approval-change';
import { useManagedSkills } from './use-managed-skills';
import { ManagedSessionCwdControl } from './ManagedSessionCwdControl';
import { toManagedPermissionRequest } from './managed-approval';
import { isNonRetryableClientError } from './managed-request-error';
import { ManagedSessionProgress } from './ManagedSessionProgress';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';
import { ManagedToolResultPanel } from './ManagedToolResultPanel';
import { ManagedTaskPanel, taskCancelMessage } from './ManagedTaskPanel';
import { useManagedTasks } from './use-managed-tasks';
import { useManagedTaskCancel } from './use-managed-task-cancel';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedInputBlock,
} from './managed-agent-provider';
import type { PromptImage, PromptFile } from '../../adapters/promptTypes';
import {
  encodeManagedInput,
  isManagedInput,
  restoreManagedAttachments,
} from './managed-input';

interface PendingPrompt {
  idempotencyKey: string;
  text: string;
  draftText?: string;
  sessionId?: string;
  cwd?: string;
  input?: ManagedInputBlock[];
}

function readPending(key: string): PendingPrompt | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const pending = value as Record<string, unknown>;
    if (
      typeof pending['idempotencyKey'] !== 'string' ||
      typeof pending['text'] !== 'string' ||
      (pending['input'] !== undefined && !isManagedInput(pending['input']))
    )
      return undefined;
    if (
      pending['sessionId'] !== undefined &&
      typeof pending['sessionId'] !== 'string'
    )
      return undefined;
    if (pending['cwd'] !== undefined && typeof pending['cwd'] !== 'string')
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

function persistPending(
  key: string,
  value: PendingPrompt | undefined,
): boolean {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function ManagedSessionsPage({
  sessionId,
  onSelectSession,
  workspaceCwd,
  managedAgentProvider,
  navigationTarget,
  interactive = true,
}: {
  sessionId?: string;
  onSelectSession: (sessionId: string | undefined) => void;
  workspaceCwd?: string;
  managedAgentProvider?: ManagedAgentProvider;
  /** Null keeps home layout while its sidebar slot is temporarily unmounted. */
  navigationTarget?: HTMLElement | null;
  interactive?: boolean;
}) {
  const { t } = useI18n();
  if (managedAgentProvider) {
    return (
      <ManagedSessionsContent
        key={managedAgentProvider.storageKey}
        sessionId={sessionId}
        onSelectSession={onSelectSession}
        workspaceCwd={workspaceCwd}
        provider={managedAgentProvider}
        cancellationEnabled={managedAgentProvider.canCancel}
        navigationTarget={navigationTarget}
        interactive={interactive}
      />
    );
  }
  return <p role="status">{t('managed.unavailable')}</p>;
}

function ManagedSessionsContent({
  sessionId,
  onSelectSession,
  workspaceCwd,
  provider,
  cancellationEnabled,
  navigationTarget,
  interactive,
}: {
  sessionId?: string;
  onSelectSession: (sessionId: string | undefined) => void;
  workspaceCwd?: string;
  provider: ManagedAgentProvider;
  cancellationEnabled: boolean;
  navigationTarget?: HTMLElement | null;
  interactive: boolean;
}) {
  const { t } = useI18n();
  const home = navigationTarget !== undefined;
  const ContextContainer = home ? 'details' : 'div';
  const clientId = useMemo(
    () => getManagedClientId(provider.storageKey),
    [provider.storageKey],
  );
  const detail = useManagedSession(provider, clientId, sessionId);
  const skills = useManagedSkills(provider, clientId, sessionId);
  const pageRef = useRef<HTMLDivElement>(null);
  const taskTriggerRef = useRef<HTMLButtonElement>(null);
  const [wideTasks, setWideTasks] = useState(false);
  const [taskPanelSession, setTaskPanelSession] = useState<string>();
  const taskPanelOpen = !!sessionId && taskPanelSession === sessionId;
  const tasks = useManagedTasks(provider, clientId, sessionId, taskPanelOpen);
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
  const [nextCursor, setNextCursor] = useState<string>();
  const [listLoading, setListLoading] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [discarded, setDiscarded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outputTarget, setOutputTarget] = useState<{
    sessionId: string;
    itemId?: string;
  }>();
  useEffect(() => setOutputTarget(undefined), [provider, sessionId]);
  useEffect(() => {
    if (detail.summary && !detail.summary.capabilities.artifacts)
      setOutputTarget(undefined);
  }, [detail.summary]);
  const openResult = useCallback(
    (itemId: string) => {
      if (sessionId) setOutputTarget({ sessionId, itemId });
    },
    [sessionId],
  );
  const pendingKey = `qwen-managed-pending:${provider.storageKey}:${clientId}`;
  const [pending, setPending] = useState<PendingPrompt | undefined>(() =>
    readPending(pendingKey),
  );
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
  const messages = useMemo(
    () => managedEventsToMessages(detail.events, t('managed.truncated')),
    [detail.events, t],
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
  );
  const pendingApproval = useMemo(
    () =>
      approvals.action
        ? toManagedPermissionRequest(approvals.action, messages)
        : null,
    [approvals.action, messages],
  );
  const cwd = useManagedCwdChange(
    provider,
    clientId,
    sessionId,
    detail.summary,
    detail.refreshSummary,
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
  // The reason line below is mounted exactly when this holds, so the dialog can
  // point at it without ever leaving a dangling IDREF. A latch-only render has
  // no `alert` node and no operable option left, so this line is the only place
  // a screen-reader user can hear why the card is dead.
  const answerNoticeShown =
    approvals.answerError !== undefined || approvals.respondForbidden;

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    const saved = readPending(pendingKey);
    pendingRef.current = saved;
    setPending(saved);
    setBusy(false);
    return () => abort.abort();
  }, [pendingKey]);

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

  // Depend on the value the request actually sends: a provider that drops
  // workspaceCwd must not refetch (and lose paged rows) on folder change.
  const listCwd = provider.acceptsWorkspaceCwd ? workspaceCwd : undefined;
  useEffect(() => {
    const abort = new AbortController();
    listLifetime.current = abort;
    listBusy.current = false;
    setSessions([]);
    setNextCursor(undefined);
    setListLoading(true);
    void provider
      .listSessions({
        clientId,
        workspaceCwd: listCwd,
        limit: 50,
        signal: abort.signal,
      })
      .then((page) => {
        if (abort.signal.aborted) return;
        setSessions(page.sessions);
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
  }, [provider, clientId, listCwd, listRevision]);

  const reloadSession = detail.reload;
  const refresh = useCallback(() => {
    setError(undefined);
    setListRevision((current) => current + 1);
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
        workspaceCwd: listCwd,
        cursor: nextCursor,
        limit: 50,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      setSessions((current) => [
        ...new Map(
          [...current, ...page.sessions].map((item) => [item.sessionId, item]),
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
  ) {
    const abort = lifetime.current;
    if (
      !abort ||
      abort.signal.aborted ||
      busy ||
      encoding.current ||
      cwd.isBlocked() ||
      modelChange.isBlocked() ||
      approvalChange.isBlocked()
    )
      return;
    setDiscarded(false);
    let attempt = pendingRef.current;
    if (!attempt) {
      if (
        (!submittedText.trim() && !images?.length && !files?.length) ||
        (sessionId && !detail.summary?.capabilities.canSend)
      )
        return;
      let input: ManagedInputBlock[];
      encoding.current = true;
      setBusy(true);
      try {
        input = await encodeManagedInput(submittedText, images, files);
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
        text: submittedText,
        draftText: composerRef.current?.getText(),
        sessionId,
        cwd: workspaceCwd,
        ...(images?.length || files?.length ? { input } : {}),
      };
      if (!persistPending(pendingKey, attempt)) {
        setError(t('managed.workspaceStorageUnavailable'));
        return;
      }
      pendingRef.current = attempt;
      setPending(attempt);
      composerCommit.current = commit;
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
      const admission = attempt.sessionId
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
              workspaceCwd: provider.acceptsWorkspaceCwd
                ? attempt.cwd
                : undefined,
            },
            opts,
          );
      if (abort.signal.aborted) return;
      pendingRef.current = undefined;
      setPending(undefined);
      persistPending(pendingKey, undefined);
      setListRevision((current) => current + 1);
      composerCommit.current?.();
      composerCommit.current = undefined;
      const draftKey = getComposerDraftStorageKey(
        undefined,
        `managed:${provider.storageKey}:${attempt.sessionId ?? 'new'}`,
      );
      for (const draft of [attempt.draftText, attempt.text]) {
        if (draft !== undefined) clearComposerDraftIfMatches(draftKey, draft);
      }
      const editor = composerRef.current;
      if (
        selection.current === attempt.sessionId &&
        editor &&
        [attempt.draftText, attempt.text].includes(editor.getText())
      ) {
        editor.clearText();
        setText('');
      }
      if (selection.current === selectedAtSubmit) {
        onSelectSession(admission.sessionId);
        detail.reload();
      }
    } catch (failure) {
      if (abort.signal.aborted) return;
      if (isNonRetryableClientError(failure)) {
        pendingRef.current = undefined;
        setPending(undefined);
        persistPending(pendingKey, undefined);
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

  const summary = detail.summary;
  const cancel = useCallback(async () => {
    const abort = lifetime.current;
    if (
      !summary?.capabilities.canCancel ||
      !summary.activeTurnId ||
      !cancellationEnabled ||
      busy ||
      !abort ||
      abort.signal.aborted
    )
      return;
    setBusy(true);
    setError(undefined);
    try {
      await provider.cancel(summary.sessionId, summary.activeTurnId, {
        clientId,
        idempotencyKey: managedRequestId(),
        signal: abort.signal,
      });
      if (!abort.signal.aborted && selection.current === summary.sessionId)
        reloadSession();
    } catch (failure) {
      if (!abort.signal.aborted && selection.current === summary.sessionId)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }, [summary, reloadSession, cancellationEnabled, busy, provider, clientId]);

  const currentSummary = summary?.sessionId === sessionId ? summary : undefined;
  const modelContext = currentSummary?.modelContext;
  const selectedModel = currentSummary?.modelSelection?.modelId;
  const displayedModel =
    selectedModel ?? modelContext?.modelId ?? currentSummary?.agentId ?? '';
  const contextUsageKnown =
    (!selectedModel || modelContext?.modelId === selectedModel) &&
    modelContext?.inputTokens !== undefined &&
    Number.isSafeInteger(modelContext.inputTokens) &&
    modelContext.inputTokens >= 0 &&
    modelContext.contextWindowSize !== undefined &&
    Number.isSafeInteger(modelContext.contextWindowSize) &&
    modelContext.contextWindowSize > 0;
  const active =
    summary &&
    !['created', 'completed', 'failed', 'cancelled'].includes(summary.phase);
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
  const navigation = (
    <nav
      ref={sessionsNavRef}
      tabIndex={-1}
      aria-label={t('managed.sessions')}
      className={`flex min-h-0 flex-col gap-1 overflow-y-auto ${home ? 'p-2' : 'max-h-48 md:max-h-none'}`}
    >
      {home && (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span>{t('managed.sessions')}</span>
          <Button variant="ghost" size="sm" onClick={refresh}>
            {t('managed.refresh')}
          </Button>
        </div>
      )}
      {sessions.map((session) => {
        const current =
          summary?.sessionId === session.sessionId ? summary : session;
        return (
          <Button
            key={session.sessionId}
            variant={sessionId === session.sessionId ? 'secondary' : 'ghost'}
            className="h-auto shrink-0 justify-start py-2 text-left"
            aria-current={sessionId === session.sessionId ? 'page' : undefined}
            onClick={() => {
              onSelectSession(session.sessionId);
              setText('');
              setError(undefined);
            }}
          >
            <span className="min-w-0">
              <span className="block truncate">
                {session.title || session.sessionId}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(`managed.phase.${current.phase}`)}
              </span>
            </span>
          </Button>
        );
      })}
      {!sessions.length && !listLoading && (
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
          disabled={listLoading}
          onClick={() => void loadMore()}
        >
          {t('managed.more')}
        </Button>
      )}
    </nav>
  );
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
            (message): message is string => Boolean(message),
          ),
        ),
      ].map((message) => (
        <p key={message} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ))}
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
        {home
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
                  summary.title === summary.sessionId
                    ? summary.sessionId.slice(0, 8)
                    : summary.title
                }
                workspaceName={summary.workspace?.workspaceId}
                workspacePath={summary.workspaceCwd}
                location={
                  <Badge variant="secondary">
                    {t(`managed.phase.${summary.phase}`)}
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
              <span className="font-medium">{summary.title}</span>
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
          {summary?.workspace && (
            <ContextContainer
              className={
                home
                  ? shellStyles.managedContext
                  : 'rounded-md border px-3 py-2 text-sm'
              }
              data-managed-workspace-binding
            >
              {home && (
                <summary className="cursor-pointer text-muted-foreground">
                  {summary.workspace.workspaceId} ·{' '}
                  {summary.workspace.cwdRelative}
                  {displayedModel && (
                    <span data-managed-model> · {displayedModel}</span>
                  )}
                  {' · '}
                  {t(`managed.runtime.${summary.runtimeState}`)}
                </summary>
              )}
              <p>
                {t('managed.workspaceBound')}: {summary.workspace.workspaceId}
              </p>
              <p>
                {t('managed.workspaceDirectory')}:{' '}
                {summary.workspace.cwdRelative}
              </p>
              {interactive && (
                <ManagedSessionCwdControl
                  key={`${provider.storageKey}:${summary.sessionId}`}
                  summary={summary}
                  supported={Boolean(provider.cwdChange)}
                  cwd={cwd}
                  disabledReason={
                    active ||
                    pendingApproval ||
                    busy ||
                    modelChange.blocked ||
                    approvalChange.blocked ||
                    pending?.sessionId === sessionId
                      ? t('managed.cwd.busy')
                      : undefined
                  }
                  onSubmit={(path, revision) => {
                    if (
                      pendingRef.current?.sessionId === sessionId ||
                      modelChange.isBlocked() ||
                      approvalChange.isBlocked() ||
                      busy ||
                      active ||
                      pendingApproval
                    )
                      return Promise.resolve();
                    return cwd.submit(path, revision);
                  }}
                />
              )}
              {!summary.capabilities.workspaceTurns && (
                <p className="text-muted-foreground">
                  {t('managed.workspaceExecutionUnavailable')}
                </p>
              )}
            </ContextContainer>
          )}
          {summary?.failure && (
            <p className="text-sm text-destructive">
              {summary.failure.message}
            </p>
          )}
          {!sessionId && provider.workspaceBinding ? (
            <WorkspaceBindingCreator
              provider={provider}
              clientId={clientId}
              interactive={interactive}
              onCreated={(createdId) => {
                setListRevision((current) => current + 1);
                onSelectSession(createdId);
              }}
              onAbandoned={() => setListRevision((current) => current + 1)}
            />
          ) : (
            <div className={shellStyles.content} style={{ flex: '1 1 auto' }}>
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
                workspaceCwd={summary?.workspaceCwd}
                hideSessionTimeline
                welcomeHeader={
                  messages.length === 0 && !detail.loading ? (
                    <WelcomeHeader
                      version=""
                      cwd={summary?.workspaceCwd ?? ''}
                      currentModel={displayedModel}
                      currentMode=""
                    />
                  ) : undefined
                }
              />
            </div>
          )}
          {pending && !busy && (
            <div className="flex items-center gap-2" role="status">
              <p className="text-sm text-muted-foreground">
                {t('managed.uncertain')}
              </p>
              <Button
                size="sm"
                disabled={busy || cwd.blocked}
                onClick={() => void submit()}
              >
                {t('managed.retry')}
              </Button>
              {/* Offered only where the handler can restore the draft:
                  destroying the only copy from a foreign session would lose
                  it for good. */}
              {pending.sessionId === sessionId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    // An escape from a permanently failing retry: reuse the
                    // draft text without minting a new idempotency key.
                    pendingRef.current = undefined;
                    setPending(undefined);
                    persistPending(pendingKey, undefined);
                    // The pending record is client-scoped but the draft
                    // belongs to the session it was written for: restore it
                    // only there.
                    if (pending.sessionId === sessionId) {
                      setText(pending.text);
                      composerRef.current?.setText(pending.text);
                      restoreManagedAttachments(
                        composerRef.current,
                        pending.input,
                      );
                    }
                    composerCommit.current = undefined;
                    setError(undefined);
                    // A create that committed server-side before an
                    // unconfirmed failure is otherwise invisible until the
                    // user happens to press Refresh.
                    if (pending.sessionId === undefined)
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
              <ToolApproval
                request={pendingApproval}
                planExecutionMode={
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
                disabled={approvals.respondForbidden}
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
                onConfirm={(actionId, optionId) =>
                  approvals.respond(actionId, optionId)
                }
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
          {(!summary?.workspace || summary.capabilities.workspaceTurns) &&
          (!provider.workspaceBinding || (sessionId && summary)) ? (
            <div
              ref={composerContainerRef}
              className={`${shellStyles.footer} flex flex-col gap-2`}
            >
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
                onSubmit={(value, images, files, commit) => {
                  void submit(value, commit, images, files);
                  return false;
                }}
                commands={[]}
                skills={skills.skills}
                onSkillsOpenChange={
                  skills.supported ? skills.onOpenChange : undefined
                }
                skillsLoading={skills.loading}
                skillsLoadError={skills.error}
                skillsLoaded={skills.loaded}
                workspaceFeaturesEnabled={false}
                attachmentsEnabled={
                  summary?.capabilities.inputAttachments === true
                }
                visibleToolbarActions={
                  interactive
                    ? [
                        ...(summary?.capabilities.inputAttachments ||
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
                  busy ||
                  Boolean(active) ||
                  Boolean(pendingApproval) ||
                  Boolean(pending) ||
                  cwd.blocked ||
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
                          cwd.isBlocked() ||
                          approvalChange.isBlocked()
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
                currentMode={summary?.approvalMode ?? ''}
                planMode={summary?.planMode === true}
                onTogglePlan={
                  summary?.planModeSupported && summary.approvalMode
                    ? () => {
                        if (
                          !busy &&
                          !encoding.current &&
                          !active &&
                          !pendingApproval &&
                          !pendingRef.current &&
                          !cwd.isBlocked() &&
                          !modelChange.isBlocked()
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
                  busy ||
                  Boolean(active) ||
                  Boolean(pendingApproval) ||
                  Boolean(pending) ||
                  cwd.blocked ||
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
                          active ||
                          pendingApproval ||
                          cwd.isBlocked() ||
                          modelChange.isBlocked()
                        )
                          return;
                        if (
                          mode === 'default' ||
                          mode === 'auto-edit' ||
                          mode === 'yolo'
                        )
                          void approvalChange.submit(mode);
                      }
                    : undefined
                }
                showChatWidthToggle={false}
                isPreparing={
                  busy || cwd.blocked || modelChange.busy || approvalChange.busy
                }
                dialogOpen={!interactive}
                isRunning={home && Boolean(active)}
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
                  modelChange.blocked ||
                  approvalChange.blocked ||
                  Boolean(sessionId && !summary?.capabilities.canSend)
                }
                placeholderText={t('managed.prompt')}
              />
              {interactive &&
                (modelChange.supported || modelChange.blocked) && (
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
                              : modelChange.optionsError
                                ? 'managed.model.optionsError'
                                : 'managed.model.nextTurn',
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
                (approvalChange.supported || approvalChange.blocked) && (
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
                              : approvalChange.optionsError
                                ? 'managed.approvalChange.optionsError'
                                : 'managed.approvalChange.nextTurn',
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
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { MessageList } from '../MessageList';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Textarea } from '../ui/textarea';
import { managedEventsToMessages } from './managed-session-messages';
import {
  getManagedClientId,
  managedRequestId,
} from './managed-session-storage';
import { useManagedSession } from './use-managed-session';
import { ManagedSessionProgress } from './ManagedSessionProgress';
import { WorkspaceBindingCreator } from './WorkspaceBindingCreator';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

interface PendingPrompt {
  idempotencyKey: string;
  text: string;
  sessionId?: string;
  cwd?: string;
}

function readPending(key: string): PendingPrompt | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (typeof value !== 'object' || value === null) return undefined;
    const pending = value as Record<string, unknown>;
    if (
      typeof pending['idempotencyKey'] !== 'string' ||
      typeof pending['text'] !== 'string'
    )
      return undefined;
    if (
      pending['sessionId'] !== undefined &&
      typeof pending['sessionId'] !== 'string'
    )
      return undefined;
    if (pending['cwd'] !== undefined && typeof pending['cwd'] !== 'string')
      return undefined;
    return value as PendingPrompt;
  } catch {
    return undefined;
  }
}

function persistPending(key: string, value: PendingPrompt | undefined): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // The in-memory attempt still preserves retries when storage is disabled.
  }
}

function isNonRetryableClientError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export function ManagedSessionsPage({
  sessionId,
  onSelectSession,
  workspaceCwd,
  managedAgentProvider,
}: {
  sessionId?: string;
  onSelectSession: (sessionId: string | undefined) => void;
  workspaceCwd?: string;
  managedAgentProvider?: ManagedAgentProvider;
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
        enabled
        cancellationEnabled={managedAgentProvider.canCancel}
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
  enabled,
  cancellationEnabled,
}: {
  sessionId?: string;
  onSelectSession: (sessionId: string | undefined) => void;
  workspaceCwd?: string;
  provider: ManagedAgentProvider;
  enabled: boolean;
  cancellationEnabled: boolean;
}) {
  const { t } = useI18n();
  const clientId = useMemo(
    () => getManagedClientId(provider.storageKey),
    [provider.storageKey],
  );
  const detail = useManagedSession(
    provider,
    clientId,
    enabled ? sessionId : undefined,
  );
  const [sessions, setSessions] = useState<ManagedAgentSessionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [listLoading, setListLoading] = useState(false);
  const [listRevision, setListRevision] = useState(0);
  const [error, setError] = useState<string>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingKey = `qwen-managed-pending:${provider.storageKey}:${clientId}`;
  const [pending, setPending] = useState<PendingPrompt | undefined>(() =>
    readPending(pendingKey),
  );
  const pendingRef = useRef(pending);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const listLifetime = useRef<AbortController | undefined>(undefined);
  const listBusy = useRef(false);
  const selection = useRef(sessionId);
  selection.current = sessionId;
  const messages = useMemo(
    () => managedEventsToMessages(detail.events, t('managed.truncated')),
    [detail.events, t],
  );

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    const saved = readPending(pendingKey);
    pendingRef.current = saved;
    setPending(saved);
    setBusy(false);
    return () => abort.abort();
  }, [pendingKey]);

  useEffect(() => {
    const abort = new AbortController();
    listLifetime.current = abort;
    listBusy.current = false;
    setSessions([]);
    setNextCursor(undefined);
    if (!enabled) return () => abort.abort();
    setListLoading(true);
    void provider
      .listSessions({
        clientId,
        workspaceCwd: provider.acceptsWorkspaceCwd ? workspaceCwd : undefined,
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
  }, [provider, clientId, enabled, workspaceCwd, listRevision]);

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
        workspaceCwd: provider.acceptsWorkspaceCwd ? workspaceCwd : undefined,
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

  async function submit() {
    const abort = lifetime.current;
    if (!abort || abort.signal.aborted || busy || !enabled) return;
    let attempt = pendingRef.current;
    if (!attempt) {
      if (!text.trim() || (sessionId && !detail.summary?.capabilities.canSend))
        return;
      attempt = {
        idempotencyKey: managedRequestId(),
        text,
        sessionId,
        cwd: workspaceCwd,
      };
      pendingRef.current = attempt;
      setPending(attempt);
      persistPending(pendingKey, attempt);
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
            { text: attempt.text },
            opts,
          )
        : await provider.createSession(
            {
              text: attempt.text,
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
      if (selection.current === selectedAtSubmit) {
        setText('');
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
      }
      if (selection.current === selectedAtSubmit)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  async function cancel() {
    const summary = detail.summary;
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
        detail.reload();
    } catch (failure) {
      if (!abort.signal.aborted && selection.current === summary.sessionId)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  if (!enabled) return <p role="status">{t('managed.unavailable')}</p>;
  const summary = detail.summary;
  const active =
    summary &&
    !['created', 'completed', 'failed', 'cancelled'].includes(summary.phase);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
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
      {(error || detail.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || detail.error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(180px,240px)_minmax(0,1fr)]">
        <nav
          aria-label={t('managed.sessions')}
          className="flex max-h-48 flex-col gap-1 overflow-y-auto md:max-h-none"
        >
          {sessions.map((session) => {
            const current =
              summary?.sessionId === session.sessionId ? summary : session;
            return (
              <Button
                key={session.sessionId}
                variant={
                  sessionId === session.sessionId ? 'secondary' : 'ghost'
                }
                className="h-auto shrink-0 justify-start py-2 text-left"
                aria-current={
                  sessionId === session.sessionId ? 'page' : undefined
                }
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
        <section
          className="flex min-h-0 min-w-0 flex-col gap-3"
          aria-label={t('managed.conversation')}
        >
          {summary && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{summary.title}</span>
              <Badge variant="secondary">
                {t(`managed.phase.${summary.phase}`)}
              </Badge>
              {summary.phase !== 'created' && (
                <span className="text-muted-foreground">
                  {t('managed.runtime')}:{' '}
                  {t(`managed.runtime.${summary.runtimeState}`)}
                </span>
              )}
            </div>
          )}
          {summary?.workspace && (
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
              <p className="text-muted-foreground">
                {t('managed.workspaceExecutionUnavailable')}
              </p>
            </div>
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
              onCreated={(createdId) => {
                setListRevision((current) => current + 1);
                onSelectSession(createdId);
              }}
            />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <MessageList
                messages={messages}
                pendingApproval={null}
                sessionKey={`managed:${provider.storageKey}:${sessionId ?? 'new'}`}
                loadingTranscript={detail.loading}
                isResponding={Boolean(active)}
                hasOlderHistory={Boolean(detail.olderCursor)}
                loadingOlderHistory={detail.loadingOlder}
                onLoadOlderHistory={detail.loadOlder}
                workspaceCwd={summary?.workspaceCwd}
                hideSessionTimeline
                welcomeHeader={
                  summary?.workspace ? null : (
                    <p className="p-4 text-muted-foreground">
                      {t('managed.prompt')}
                    </p>
                  )
                }
              />
            </div>
          )}
          {pending && !busy && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('managed.uncertain')}
            </p>
          )}
          <ManagedSessionProgress
            summary={summary}
            submitting={
              busy && Boolean(pending) && pending?.sessionId === sessionId
            }
            loading={detail.loading}
          />
          {!summary?.workspace &&
          (!provider.workspaceBinding || (sessionId && summary)) ? (
            <form
              className="flex shrink-0 flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Textarea
                aria-label={t('managed.prompt')}
                value={pending?.text ?? text}
                onChange={(event) => setText(event.target.value)}
                disabled={
                  busy ||
                  Boolean(pending) ||
                  Boolean(sessionId && !summary?.capabilities.canSend)
                }
                placeholder={t('managed.prompt')}
              />
              <div className="flex items-center justify-end gap-2">
                {sessionId &&
                  !active &&
                  summary &&
                  !summary.capabilities.canSend && (
                    <span className="mr-auto text-sm text-muted-foreground">
                      {t('managed.newRequired')}
                    </span>
                  )}
                {cancellationEnabled &&
                  summary?.capabilities.canCancel &&
                  summary.activeTurnId && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void cancel()}
                    >
                      {t('managed.cancel')}
                    </Button>
                  )}
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    (!pending &&
                      (!text.trim() ||
                        Boolean(sessionId && !summary?.capabilities.canSend)))
                  }
                >
                  {busy
                    ? t('managed.sending')
                    : pending
                      ? t('managed.retry')
                      : t('managed.send')}
                </Button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </div>
  );
}

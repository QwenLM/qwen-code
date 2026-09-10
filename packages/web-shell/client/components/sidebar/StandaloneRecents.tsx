import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CircleDashedIcon, SquarePenIcon } from 'lucide-react';
import {
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonSessionArchiveState,
  type DaemonStandaloneSessionSummary,
} from '@qwen-code/sdk/daemon';
import {
  useConnection,
  useStreamingState,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { SIDEBAR_SESSION_PREVIEW_LIMIT } from '../../constants/sessions';
import {
  getDaemonErrorCode,
  isSessionWriterBlockedCode,
} from '../../daemon/session/session-context';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import sidebarStyles from './WebShellSidebar.module.css';
import workspaceStyles from './WorkspaceSection.module.css';

interface StandaloneRecentsProps {
  archiveState: DaemonSessionArchiveState;
  currentSessionId?: string;
  currentSessionReady?: boolean;
  refreshKey?: number;
  searchQuery?: string;
  onNewSession?: () => void;
  renderSession: (
    session: DaemonStandaloneSessionSummary,
    options: {
      active: boolean;
      busy: boolean;
      isArchived: boolean;
      onOpen: () => void;
      onRename: () => void;
      onExport: () => void;
      onArchive?: () => void;
      onUnarchive?: () => void;
      onDelete: () => void;
    },
  ) => ReactNode;
  onLoadSession: (sessionId: string) => Promise<void> | void;
  onRenameSession?: (sessionId: string, displayName: string) => void;
  onMutated?: () => void;
  onStatusChange?: (status: {
    count: number;
    loading: boolean;
    error: boolean;
  }) => void;
  onError: (error: unknown, fallback: string) => void;
  onNotice: (message: string) => void;
}

const PAGE_SIZE = 50;
function sessionLabel(session: DaemonStandaloneSessionSummary): string {
  return session.displayName?.trim() || session.sessionId.slice(0, 8);
}

function withoutChildren(
  sessions: readonly DaemonStandaloneSessionSummary[],
): DaemonStandaloneSessionSummary[] {
  return sessions.filter((session) => !session.parentSessionId);
}

function appendUnique(
  current: readonly DaemonStandaloneSessionSummary[],
  incoming: readonly DaemonStandaloneSessionSummary[],
): DaemonStandaloneSessionSummary[] {
  const known = new Set(current.map((session) => session.sessionId));
  return [
    ...current,
    ...incoming.filter((session) => !known.has(session.sessionId)),
  ];
}

function downloadExport(result: {
  content: string;
  filename: string;
  mimeType: string;
}): void {
  const url = URL.createObjectURL(
    new Blob([result.content], { type: result.mimeType || 'text/html' }),
  );
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function StandaloneRecents({
  archiveState,
  currentSessionId,
  currentSessionReady = false,
  refreshKey,
  searchQuery = '',
  onNewSession,
  renderSession,
  onLoadSession,
  onRenameSession,
  onMutated,
  onStatusChange,
  onError,
  onNotice,
}: StandaloneRecentsProps) {
  const workspace = useWorkspace();
  const connection = useConnection();
  const streamingState = useStreamingState();
  const previousStreamingStateRef = useRef(streamingState);
  const loadGenerationRef = useRef(0);
  const loadedRef = useRef(false);
  const previousRefreshKeyRef = useRef(refreshKey);
  const busySessionIdRef = useRef<string | undefined>(undefined);
  const openGenerationRef = useRef(0);
  const openingSessionIdRef = useRef<string | undefined>(undefined);
  const { t } = useI18n();
  const [sessions, setSessions] = useState<DaemonStandaloneSessionSummary[]>(
    [],
  );
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [cursor, setCursor] = useState<string>();
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<{ cursor?: string }>();
  const [busySessionId, setBusySessionId] = useState<string>();
  const [sessionError, setSessionError] = useState<{
    sessionId: string;
    kind: 'open' | 'action';
    messageKey: 'session.writerBlocked' | 'session.loadFailed';
    retry: () => void;
  }>();
  const [renameCandidate, setRenameCandidate] =
    useState<DaemonStandaloneSessionSummary>();
  const [renameValue, setRenameValue] = useState('');
  const [deleteCandidate, setDeleteCandidate] =
    useState<DaemonStandaloneSessionSummary>();
  const supported =
    workspace.capabilities?.features?.includes(
      STANDALONE_SESSIONS_CAPABILITY,
    ) === true;

  const load = useCallback(
    async (preservePages = false) => {
      if (!supported) return;
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      setLoadingMore(false);
      setLoading(true);
      try {
        const targetCount = preservePages ? sessionsRef.current.length : 0;
        let page = await workspace.client.listStandaloneSessionsPage({
          archiveState,
          pageSize: PAGE_SIZE,
        });
        if (loadGenerationRef.current !== generation) return;
        let loaded = withoutChildren(page.sessions);
        while (page.nextCursor && loaded.length < targetCount) {
          page = await workspace.client.listStandaloneSessionsPage({
            archiveState,
            cursor: page.nextCursor,
            pageSize: PAGE_SIZE,
          });
          if (loadGenerationRef.current !== generation) return;
          loaded = appendUnique(loaded, withoutChildren(page.sessions));
        }
        loadedRef.current = true;
        setSessions(loaded);
        setCursor(page.nextCursor);
        setLoadError(undefined);
      } catch (error) {
        if (loadGenerationRef.current !== generation) return;
        console.warn('[web-shell] standalone session list failed:', error);
        setLoadError({});
      } finally {
        if (loadGenerationRef.current === generation) setLoading(false);
      }
    },
    [archiveState, supported, workspace.client],
  );

  useEffect(() => {
    setSessionError((current) =>
      current?.kind === 'open' ? undefined : current,
    );
    if (openingSessionIdRef.current !== currentSessionId)
      ++openGenerationRef.current;
  }, [currentSessionId]);

  useEffect(() => {
    if (currentSessionReady) {
      setSessionError((current) =>
        current?.kind === 'open' && current.sessionId === currentSessionId
          ? undefined
          : current,
      );
    }
  }, [currentSessionId, currentSessionReady]);

  useEffect(() => {
    const refreshRequested = previousRefreshKeyRef.current !== refreshKey;
    previousRefreshKeyRef.current = refreshKey;
    if (!loadedRef.current || refreshRequested) void load(true);
  }, [load, refreshKey]);

  useEffect(() => {
    const previous = previousStreamingStateRef.current;
    previousStreamingStateRef.current = streamingState;
    if (
      archiveState === 'active' &&
      connection.sessionContext?.kind === 'standalone' &&
      previous !== 'idle' &&
      streamingState === 'idle'
    ) {
      void load(true);
    }
  }, [archiveState, connection.sessionContext?.kind, load, streamingState]);

  useEffect(() => {
    onStatusChange?.({ count: sessions.length, loading, error: !!loadError });
  }, [loadError, loading, onStatusChange, sessions.length]);

  useEffect(() => {
    if (!expanded) setShowAll(false);
  }, [expanded]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    try {
      const page = await workspace.client.listStandaloneSessionsPage({
        archiveState,
        cursor,
        pageSize: PAGE_SIZE,
      });
      if (loadGenerationRef.current !== generation) return;
      setSessions((current) =>
        appendUnique(current, withoutChildren(page.sessions)),
      );
      setCursor(page.nextCursor);
      setLoadError(undefined);
    } catch (error) {
      if (loadGenerationRef.current === generation) {
        console.warn('[web-shell] standalone session page failed:', error);
        setLoadError({ cursor });
      }
    } finally {
      if (loadGenerationRef.current === generation) setLoadingMore(false);
    }
  }, [archiveState, cursor, loadingMore, workspace.client]);

  const run = useCallback(
    async (
      sessionId: string,
      action: () => Promise<void>,
    ): Promise<boolean> => {
      if (busySessionIdRef.current) return false;
      busySessionIdRef.current = sessionId;
      setBusySessionId(sessionId);
      setSessionError(undefined);
      try {
        await action();
        return true;
      } catch (error) {
        if (isSessionWriterBlockedCode(getDaemonErrorCode(error))) {
          console.warn(
            '[web-shell] standalone session action blocked by writer fence:',
            error,
          );
          setRenameCandidate((current) =>
            current?.sessionId === sessionId ? undefined : current,
          );
          setDeleteCandidate((current) =>
            current?.sessionId === sessionId ? undefined : current,
          );
          setSessionError({
            sessionId,
            kind: 'action',
            messageKey: 'session.writerBlocked',
            retry: () => {
              void run(sessionId, action);
            },
          });
        } else {
          onError(error, t('sidebar.standaloneActionFailed'));
        }
        return false;
      } finally {
        busySessionIdRef.current = undefined;
        setBusySessionId(undefined);
      }
    },
    [onError, t],
  );

  const removeMutated = useCallback(
    (sessionId: string) => {
      setSessions((current) =>
        current.filter((entry) => entry.sessionId !== sessionId),
      );
      onMutated?.();
    },
    [onMutated],
  );

  const archiveSession = useCallback(
    async (session: DaemonStandaloneSessionSummary) => {
      await run(session.sessionId, async () => {
        const result = await workspace.client.archiveStandaloneSessions([
          session.sessionId,
        ]);
        if (
          result.archived.includes(session.sessionId) ||
          result.alreadyArchived.includes(session.sessionId) ||
          result.notFound?.includes(session.sessionId)
        ) {
          removeMutated(session.sessionId);
          return;
        }
        const failure = result.errors.find(
          (entry) => entry.sessionId === session.sessionId,
        );
        throw Object.assign(
          new Error(failure?.message ?? t('sidebar.standaloneActionFailed')),
          { body: failure },
        );
      });
    },
    [removeMutated, run, t, workspace.client],
  );

  const unarchiveSession = useCallback(
    async (session: DaemonStandaloneSessionSummary) => {
      await run(session.sessionId, async () => {
        const result = await workspace.client.unarchiveStandaloneSessions([
          session.sessionId,
        ]);
        if (
          result.unarchived.includes(session.sessionId) ||
          result.alreadyActive.includes(session.sessionId) ||
          result.notFound?.includes(session.sessionId)
        ) {
          removeMutated(session.sessionId);
          return;
        }
        const failure = result.errors.find(
          (entry) => entry.sessionId === session.sessionId,
        );
        throw Object.assign(
          new Error(failure?.message ?? t('sidebar.standaloneActionFailed')),
          { body: failure },
        );
      });
    },
    [removeMutated, run, t, workspace.client],
  );

  const deleteSession = useCallback(
    async (session: DaemonStandaloneSessionSummary): Promise<boolean> => {
      const succeeded = await run(session.sessionId, async () => {
        const result = await workspace.client.deleteStandaloneSessions([
          session.sessionId,
        ]);
        if (
          !result.removed.includes(session.sessionId) &&
          !result.notFound.includes(session.sessionId)
        ) {
          const failure = result.errors.find(
            (entry) => entry.sessionId === session.sessionId,
          );
          throw Object.assign(
            new Error(failure?.message ?? t('sidebar.standaloneActionFailed')),
            { body: failure },
          );
        }
        if (result.fileCleanupPending.includes(session.sessionId)) {
          onNotice(t('sidebar.standaloneCleanupPending'));
        }
        removeMutated(session.sessionId);
      });
      return succeeded;
    },
    [onNotice, removeMutated, run, t, workspace.client],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      const generation = ++openGenerationRef.current;
      openingSessionIdRef.current = sessionId;
      setSessionError(undefined);
      try {
        await onLoadSession(sessionId);
      } catch (error) {
        if (generation !== openGenerationRef.current) return;
        if (isSessionWriterBlockedCode(getDaemonErrorCode(error))) return;
        console.warn('[web-shell] standalone session load failed:', error);
        setSessionError({
          sessionId,
          kind: 'open',
          messageKey: 'session.loadFailed',
          retry: () => {
            void openSession(sessionId);
          },
        });
      }
    },
    [onLoadSession],
  );

  if (!supported) return null;
  if (
    archiveState === 'archived' &&
    !loadError &&
    !sessionError &&
    !loading &&
    sessions.length === 0 &&
    !cursor
  ) {
    return null;
  }
  const query = searchQuery.trim().toLowerCase();
  const visibleSessions = query
    ? sessions.filter(
        (session) =>
          sessionLabel(session).toLowerCase().includes(query) ||
          session.sessionId.toLowerCase().includes(query),
      )
    : sessions;
  const sessionsLimited =
    !query &&
    !showAll &&
    visibleSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT;
  const displayedSessions = sessionsLimited
    ? visibleSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT)
    : visibleSessions;

  return (
    <>
      <section
        className={`${workspaceStyles.section} mb-3`}
        aria-label={
          archiveState === 'active'
            ? t('sidebar.noWorkspaceSessions')
            : `${t('sidebar.archivedTitle')}: ${t('sidebar.noWorkspaceSessions')}`
        }
        data-testid={`standalone-${archiveState}-group`}
      >
        <div className={`${workspaceStyles.headerRow} group`}>
          <button
            type="button"
            className={workspaceStyles.header}
            aria-expanded={expanded}
            onClick={(event) => {
              setExpanded((value) => !value);
              if (event.detail > 0) event.currentTarget.blur();
            }}
          >
            <CircleDashedIcon
              className={workspaceStyles.folderIcon}
              size={14}
              strokeWidth={1.4}
              aria-hidden="true"
            />
            <span className={workspaceStyles.headerContent}>
              <span className={workspaceStyles.name}>
                {t('sidebar.noWorkspaceSessions')}
              </span>
            </span>
          </button>
          {archiveState === 'active' && onNewSession && (
            <div
              className={`${sidebarStyles.workspaceHeaderActions} invisible group-hover:visible group-focus-within:visible`}
            >
              <button
                className={sidebarStyles.workspaceHeaderAction}
                type="button"
                title={t('sidebar.newTask')}
                aria-label={t('sidebar.newTask')}
                onClick={onNewSession}
              >
                <SquarePenIcon size={16} strokeWidth={1.2} />
              </button>
            </div>
          )}
        </div>
        {sessionError && (
          <div role="alert" className="px-2 py-1 text-xs text-muted-foreground">
            <span>
              {sessionError.sessionId.slice(0, 8)}: {t(sessionError.messageKey)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busySessionId}
              onClick={sessionError.retry}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {loadError && (
          <div role="alert" className="px-2 py-1 text-xs text-muted-foreground">
            {t('sidebar.standaloneLoadFailed')}
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || loadingMore}
              onClick={() => {
                void (loadError.cursor ? loadMore() : load(true));
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        )}
        {(expanded || Boolean(query)) && (
          <div className="flex flex-col gap-0.5">
            {displayedSessions.map((session) => {
              const isCurrent = session.sessionId === currentSessionId;
              return renderSession(session, {
                active: isCurrent,
                busy: busySessionId === session.sessionId,
                isArchived: archiveState === 'archived',
                onOpen: () => void openSession(session.sessionId),
                onRename: () => {
                  setRenameCandidate(session);
                  setRenameValue(sessionLabel(session));
                },
                onExport: () => {
                  void run(session.sessionId, async () => {
                    downloadExport(
                      await workspace.client.exportStandaloneSession(
                        session.sessionId,
                        { format: 'html' },
                      ),
                    );
                  });
                },
                onArchive:
                  archiveState === 'active'
                    ? () => void archiveSession(session)
                    : undefined,
                onUnarchive:
                  archiveState === 'archived'
                    ? () => void unarchiveSession(session)
                    : undefined,
                onDelete: () => setDeleteCandidate(session),
              });
            })}
            {!loading && !loadError && visibleSessions.length === 0 && (
              <div className={workspaceStyles.empty}>
                {archiveState === 'active'
                  ? t('sidebar.noSessions')
                  : t('sidebar.archivedEmpty')}
              </div>
            )}
            {sessionsLimited && (
              <button
                type="button"
                className={sidebarStyles.showAllSessions}
                onClick={() => setShowAll(true)}
              >
                {t('sidebar.showAllSessions')}
              </button>
            )}
            {cursor && !sessionsLimited && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {t('sidebar.showAllSessions')}
              </Button>
            )}
          </div>
        )}
      </section>
      {renameCandidate && (
        <DialogShell
          title={t('sidebar.rename')}
          size="sm"
          onClose={() => setRenameCandidate(undefined)}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const displayName = renameValue.trim();
              if (!displayName) return;
              void run(renameCandidate.sessionId, async () => {
                await workspace.client.renameStandaloneSession(
                  renameCandidate.sessionId,
                  displayName,
                );
                setSessions((current) =>
                  current.map((session) =>
                    session.sessionId === renameCandidate.sessionId
                      ? { ...session, displayName }
                      : session,
                  ),
                );
                onRenameSession?.(renameCandidate.sessionId, displayName);
              }).then((succeeded) => {
                if (succeeded) setRenameCandidate(undefined);
              });
            }}
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameCandidate(undefined)}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!renameValue.trim()}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        </DialogShell>
      )}
      {deleteCandidate && (
        <DialogShell
          title={t('sidebar.delete')}
          size="sm"
          onClose={() => setDeleteCandidate(undefined)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t('sidebar.standaloneDeleteConfirm')}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteCandidate(undefined)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  void deleteSession(deleteCandidate).then((succeeded) => {
                    if (succeeded) setDeleteCandidate(undefined);
                  });
                }}
              >
                {t('sidebar.delete')}
              </Button>
            </div>
          </div>
        </DialogShell>
      )}
    </>
  );
}

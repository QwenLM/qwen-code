import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ArchiveIcon,
  DownloadIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PencilIcon,
  RotateCcwIcon,
  SquarePenIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonSessionArchiveState,
  type DaemonStandaloneSessionSummary,
} from '@qwen-code/sdk/daemon';
import {
  useStreamingState,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';

interface StandaloneRecentsProps {
  collapsed: boolean;
  onExpand: () => void;
  currentSessionId?: string;
  onLoadSession: (sessionId: string) => Promise<void> | void;
  /** Starts a standalone chat. Omitted when the host cannot create one. */
  onNewSession?: () => void;
  newSessionDisabled?: boolean;
  onRenameSession?: (sessionId: string, displayName: string) => void;
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

function mergeRefreshedPage(
  current: readonly DaemonStandaloneSessionSummary[],
  refreshed: readonly DaemonStandaloneSessionSummary[],
): DaemonStandaloneSessionSummary[] {
  const refreshedIds = new Set(refreshed.map((session) => session.sessionId));
  return [
    ...refreshed,
    ...current.filter((session) => !refreshedIds.has(session.sessionId)),
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
  collapsed,
  onExpand,
  currentSessionId,
  onLoadSession,
  onNewSession,
  newSessionDisabled,
  onRenameSession,
  onError,
  onNotice,
}: StandaloneRecentsProps) {
  const workspace = useWorkspace();
  const streamingState = useStreamingState();
  const previousStreamingStateRef = useRef(streamingState);
  const loadGenerationRef = useRef(0);
  const archivedLoadGenerationRef = useRef(0);
  const busySessionIdRef = useRef<string | undefined>(undefined);
  const { t } = useI18n();
  const [active, setActive] = useState<DaemonStandaloneSessionSummary[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [archived, setArchived] = useState<DaemonStandaloneSessionSummary[]>(
    [],
  );
  const archivedRef = useRef(archived);
  archivedRef.current = archived;
  const [activeCursor, setActiveCursor] = useState<string>();
  const [archivedCursor, setArchivedCursor] = useState<string>();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [loadingActive, setLoadingActive] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [loadingMore, setLoadingMore] = useState<DaemonSessionArchiveState>();
  const [busySessionId, setBusySessionId] = useState<string>();
  const [renameCandidate, setRenameCandidate] =
    useState<DaemonStandaloneSessionSummary>();
  const [renameValue, setRenameValue] = useState('');
  const [deleteCandidate, setDeleteCandidate] =
    useState<DaemonStandaloneSessionSummary>();
  const supported =
    workspace.capabilities?.features?.includes(
      STANDALONE_SESSIONS_CAPABILITY,
    ) === true;
  const loading = loadingActive || (archivedExpanded && loadingArchived);

  const load = useCallback(
    async (preserveActivePages = false) => {
      if (!supported) return;
      const generation = loadGenerationRef.current + 1;
      loadGenerationRef.current = generation;
      setLoadingMore((current) => (current === 'active' ? undefined : current));
      setLoadingActive(true);
      try {
        const activePage = await workspace.client.listStandaloneSessionsPage({
          archiveState: 'active',
          pageSize: PAGE_SIZE,
        });
        if (loadGenerationRef.current !== generation) return;
        const activeSessions = withoutChildren(activePage.sessions);
        const preserveLoadedPages =
          preserveActivePages && activeRef.current.length > 0;
        setActive((current) =>
          preserveLoadedPages
            ? mergeRefreshedPage(current, activeSessions)
            : activeSessions,
        );
        if (!preserveLoadedPages) setActiveCursor(activePage.nextCursor);
      } catch (error) {
        if (loadGenerationRef.current !== generation) return;
        onError(error, t('sidebar.standaloneLoadFailed'));
      } finally {
        if (loadGenerationRef.current === generation) setLoadingActive(false);
      }
    },
    [onError, supported, t, workspace.client],
  );

  const loadArchived = useCallback(
    async (preserveArchivedPages = false) => {
      if (!supported) return;
      const generation = archivedLoadGenerationRef.current + 1;
      archivedLoadGenerationRef.current = generation;
      setLoadingMore((current) =>
        current === 'archived' ? undefined : current,
      );
      setLoadingArchived(true);
      try {
        const page = await workspace.client.listStandaloneSessionsPage({
          archiveState: 'archived',
          pageSize: PAGE_SIZE,
        });
        if (archivedLoadGenerationRef.current !== generation) return;
        const archivedSessions = withoutChildren(page.sessions);
        const preserveLoadedPages =
          preserveArchivedPages && archivedRef.current.length > 0;
        setArchived((current) =>
          preserveLoadedPages
            ? mergeRefreshedPage(current, archivedSessions)
            : archivedSessions,
        );
        if (!preserveLoadedPages) setArchivedCursor(page.nextCursor);
      } catch (error) {
        if (archivedLoadGenerationRef.current !== generation) return;
        onError(error, t('sidebar.standaloneLoadFailed'));
      } finally {
        if (archivedLoadGenerationRef.current === generation) {
          setLoadingArchived(false);
        }
      }
    },
    [onError, supported, t, workspace.client],
  );

  const loadMore = useCallback(
    async (archiveState: DaemonSessionArchiveState, cursor: string) => {
      if (loadingMore) return;
      const generation =
        archiveState === 'active'
          ? loadGenerationRef.current
          : archivedLoadGenerationRef.current;
      setLoadingMore(archiveState);
      try {
        const page = await workspace.client.listStandaloneSessionsPage({
          archiveState,
          cursor,
          pageSize: PAGE_SIZE,
        });
        if (
          (archiveState === 'active'
            ? loadGenerationRef.current
            : archivedLoadGenerationRef.current) !== generation
        ) {
          return;
        }
        const sessions = withoutChildren(page.sessions);
        if (archiveState === 'active') {
          setActive((current) => appendUnique(current, sessions));
          setActiveCursor(page.nextCursor);
        } else {
          setArchived((current) => appendUnique(current, sessions));
          setArchivedCursor(page.nextCursor);
        }
      } catch (error) {
        if (
          (archiveState === 'active'
            ? loadGenerationRef.current
            : archivedLoadGenerationRef.current) !== generation
        ) {
          return;
        }
        onError(error, t('sidebar.standaloneLoadFailed'));
      } finally {
        if (
          (archiveState === 'active'
            ? loadGenerationRef.current
            : archivedLoadGenerationRef.current) === generation
        ) {
          setLoadingMore(undefined);
        }
      }
    },
    [loadingMore, onError, t, workspace.client],
  );

  useEffect(() => {
    void load(true);
  }, [currentSessionId, load]);

  useEffect(() => {
    if (archivedExpanded) void loadArchived(true);
  }, [archivedExpanded, loadArchived]);

  useEffect(() => {
    const previous = previousStreamingStateRef.current;
    previousStreamingStateRef.current = streamingState;
    if (previous !== 'idle' && streamingState === 'idle') void load(true);
  }, [load, streamingState]);

  const refreshLists = useCallback(async () => {
    await Promise.all([load(), archivedExpanded ? loadArchived() : undefined]);
  }, [archivedExpanded, load, loadArchived]);

  const run = useCallback(
    async (
      sessionId: string,
      action: () => Promise<void>,
      refresh = true,
    ): Promise<boolean> => {
      if (busySessionIdRef.current) return false;
      busySessionIdRef.current = sessionId;
      setBusySessionId(sessionId);
      try {
        await action();
        if (refresh) await refreshLists();
        return true;
      } catch (error) {
        onError(error, t('sidebar.standaloneActionFailed'));
        return false;
      } finally {
        busySessionIdRef.current = undefined;
        setBusySessionId(undefined);
      }
    },
    [onError, refreshLists, t],
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
          return;
        }
        const failure = result.errors.find(
          (entry) => entry.sessionId === session.sessionId,
        );
        throw new Error(
          failure?.message ?? t('sidebar.standaloneActionFailed'),
        );
      });
    },
    [run, t, workspace.client],
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
          return;
        }
        const failure = result.errors.find(
          (entry) => entry.sessionId === session.sessionId,
        );
        throw new Error(
          failure?.message ?? t('sidebar.standaloneActionFailed'),
        );
      });
    },
    [run, t, workspace.client],
  );

  const deleteSession = useCallback(
    async (session: DaemonStandaloneSessionSummary): Promise<boolean> =>
      await run(session.sessionId, async () => {
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
          throw new Error(
            failure?.message ?? t('sidebar.standaloneActionFailed'),
          );
        }
        if (result.fileCleanupPending.includes(session.sessionId)) {
          onNotice(t('sidebar.standaloneCleanupPending'));
        }
      }),
    [onNotice, run, t, workspace.client],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      try {
        await onLoadSession(sessionId);
      } catch (error) {
        onError(error, t('session.loadFailed'));
      }
    },
    [onError, onLoadSession, t],
  );

  if (!supported) return null;
  if (collapsed) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title={t('sidebar.recents')}
        aria-label={t('sidebar.recents')}
        onClick={onExpand}
      >
        <MessageSquareIcon />
      </Button>
    );
  }

  return (
    <>
      <section className="px-2 pb-3" aria-label={t('sidebar.recents')}>
        <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-muted-foreground">
          <span>{t('sidebar.recents')}</span>
          <span className="flex items-center gap-1">
            {loading && <span>{t('common.loading')}</span>}
            {onNewSession && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={t('sidebar.newStandaloneSession')}
                disabled={newSessionDisabled}
                onClick={onNewSession}
              >
                <SquarePenIcon />
                {t('sidebar.newStandaloneSession')}
              </Button>
            )}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {active.map((session) => {
            const isCurrent = session.sessionId === currentSessionId;
            return (
              <StandaloneRow
                key={session.sessionId}
                session={session}
                active={isCurrent}
                busy={busySessionId === session.sessionId}
                onOpen={() => void openSession(session.sessionId)}
                onRename={() => {
                  setRenameCandidate(session);
                  setRenameValue(sessionLabel(session));
                }}
                onExport={() => {
                  void run(
                    session.sessionId,
                    async () => {
                      downloadExport(
                        await workspace.client.exportStandaloneSession(
                          session.sessionId,
                          { format: 'html' },
                        ),
                      );
                    },
                    false,
                  );
                }}
                onArchive={
                  isCurrent ? undefined : () => void archiveSession(session)
                }
                onDelete={
                  isCurrent ? undefined : () => setDeleteCandidate(session)
                }
              />
            );
          })}
        </div>
        {!loading && active.length === 0 && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {t('sidebar.noRecents')}
          </div>
        )}
        {activeCursor && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={loadingMore === 'active'}
            onClick={() => void loadMore('active', activeCursor)}
          >
            {t('sidebar.showAllSessions')}
          </Button>
        )}
        <button
          type="button"
          className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
          aria-expanded={archivedExpanded}
          onClick={() => setArchivedExpanded((value) => !value)}
        >
          <ArchiveIcon size={13} />
          {t('sidebar.archivedTitle')}
        </button>
        {archivedExpanded && archived.length === 0 && !loading && (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {t('sidebar.archivedEmpty')}
          </div>
        )}
        {archivedExpanded &&
          archived.map((session) => (
            <StandaloneRow
              key={session.sessionId}
              session={session}
              active={false}
              busy={busySessionId === session.sessionId}
              onOpen={() => undefined}
              onExport={() => {
                void run(
                  session.sessionId,
                  async () => {
                    downloadExport(
                      await workspace.client.exportStandaloneSession(
                        session.sessionId,
                        { format: 'html' },
                      ),
                    );
                  },
                  false,
                );
              }}
              onUnarchive={() => void unarchiveSession(session)}
              onDelete={() => setDeleteCandidate(session)}
            />
          ))}
        {archivedExpanded && archivedCursor && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            disabled={loadingMore === 'archived'}
            onClick={() => void loadMore('archived', archivedCursor)}
          >
            {t('sidebar.showAllSessions')}
          </Button>
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
              void run(
                renameCandidate.sessionId,
                async () => {
                  await workspace.client.renameStandaloneSession(
                    renameCandidate.sessionId,
                    displayName,
                  );
                  const updateName = (
                    sessions: readonly DaemonStandaloneSessionSummary[],
                  ) =>
                    sessions.map((session) =>
                      session.sessionId === renameCandidate.sessionId
                        ? { ...session, displayName }
                        : session,
                    );
                  setActive(updateName);
                  setArchived(updateName);
                  onRenameSession?.(renameCandidate.sessionId, displayName);
                },
                false,
              ).then((succeeded) => {
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

function StandaloneRow({
  session,
  active,
  busy,
  onOpen,
  onRename,
  onExport,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  session: DaemonStandaloneSessionSummary;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onRename?: () => void;
  onExport: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`group flex items-center rounded px-1 ${active ? 'bg-muted' : 'hover:bg-muted/60'}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 truncate px-1 py-1.5 text-left text-sm"
        title={sessionLabel(session)}
        disabled={busy || session.isArchived === true}
        onClick={onOpen}
      >
        {sessionLabel(session)}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('sidebar.sessionActions')}
            disabled={busy}
          >
            <EllipsisIcon size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {onRename && (
              <StandaloneAction
                icon={<PencilIcon />}
                label={t('sidebar.rename')}
                onClick={onRename}
              />
            )}
            <StandaloneAction
              icon={<DownloadIcon />}
              label={t('sidebar.export')}
              onClick={onExport}
            />
            {onArchive && (
              <StandaloneAction
                icon={<ArchiveIcon />}
                label={t('sidebar.archive')}
                onClick={onArchive}
              />
            )}
            {onUnarchive && (
              <StandaloneAction
                icon={<RotateCcwIcon />}
                label={t('sidebar.unarchive')}
                onClick={onUnarchive}
              />
            )}
            {onDelete && (
              <StandaloneAction
                icon={<Trash2Icon />}
                label={t('sidebar.delete')}
                onClick={onDelete}
                danger
              />
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function StandaloneAction({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <DropdownMenuItem
      className={danger ? 'text-destructive focus:text-destructive' : undefined}
      onSelect={onClick}
    >
      <span className="size-4">{icon}</span>
      {label}
    </DropdownMenuItem>
  );
}

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  useActions,
  useConnection,
  useSessions,
} from '@qwen-code/webui/daemon-react-sdk';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { DialogShell } from '../dialogs/DialogShell';
import styles from './WebShellSidebar.module.css';

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_SESSION_PAGE_SIZE = 1000;
const ACTIVE_SESSION_POLL_INTERVAL_MS = 2000;
const IDLE_SESSION_POLL_INTERVAL_MS = 30_000;

interface WebShellSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onOpenDashboard?: () => void;
  onNewSession: () => Promise<boolean> | boolean;
  onLoadSession: (sessionId: string) => Promise<void> | void;
  onError: (error: unknown, fallback: string) => void;
  mobileOpen?: boolean;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function getWorkspaceName(workspaceCwd: string | undefined): string {
  if (!workspaceCwd) return '';
  const parts = workspaceCwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? workspaceCwd;
}

function getSessionLabel(session: DaemonSessionSummary): string {
  const displayName = session.displayName?.trim();
  return displayName || session.sessionId.slice(0, 8);
}

function getSessionCreatedTime(session: DaemonSessionSummary): number {
  if (!session.createdAt) return 0;
  const time = Date.parse(session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function readSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = raw ? Number(raw) : SIDEBAR_DEFAULT_WIDTH;
    return Number.isFinite(width)
      ? clampSidebarWidth(width)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(
      SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampSidebarWidth(width)),
    );
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function IconNewChat() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function IconFolder({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {expanded ? (
        <>
          <path d="M3.25 8.6V7.4A2.4 2.4 0 0 1 5.65 5h4.1l2.1 2.1h6.5a2.4 2.4 0 0 1 2.4 2.4v1.1" />
          <path d="M4.3 10.6h14.9a1.75 1.75 0 0 1 1.68 2.24l-1.32 4.5A2.4 2.4 0 0 1 17.25 19H5.05a2.4 2.4 0 0 1-2.34-2.94l.86-3.75A2.2 2.2 0 0 1 5.72 10.6" />
        </>
      ) : (
        <>
          <path d="M3.25 8.2V7.4A2.4 2.4 0 0 1 5.65 5h4.1l2.1 2.1h6.5a2.4 2.4 0 0 1 2.4 2.4v.7" />
          <path d="M3.25 8.2h17.5v7.9a2.4 2.4 0 0 1-2.4 2.4H5.65a2.4 2.4 0 0 1-2.4-2.4V8.2Z" />
        </>
      )}
    </svg>
  );
}

function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7A2 2 0 1 1 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 .9-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5.9h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function IconDashboard() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function IconRename() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h5l10-10a3 3 0 0 0-5-5L4 15v5Z" />
      <path d="M13.5 5.5 18.5 10.5" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

function IconCollapse({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {collapsed ? <path d="M9 6l6 6-6 6" /> : <path d="M15 6l-6 6 6 6" />}
    </svg>
  );
}

function IconChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {expanded ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
    </svg>
  );
}

export function WebShellSidebar({
  collapsed,
  onCollapsedChange,
  onOpenSettings,
  onOpenDashboard,
  onNewSession,
  onLoadSession,
  onError,
  mobileOpen,
}: WebShellSidebarProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const { sessions, loading, error, reload, deleteSession } = useSessions({
    autoLoad: true,
    pageSize: SIDEBAR_SESSION_PAGE_SIZE,
  });
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const busySessionIdRef = useRef<string | null>(null);
  const creatingSessionRef = useRef(false);
  const [deleteCandidate, setDeleteCandidate] =
    useState<DaemonSessionSummary | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [projectExpanded, setProjectExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [tooltip, setTooltip] = useState<{
    content: ReactNode;
    top: number;
    left: number;
  } | null>(null);
  const [completedUnreadIds, setCompletedUnreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tooltipHideTimer = useRef<number | null>(null);
  const previousRunningRef = useRef<Map<string, boolean> | null>(null);
  const pollInFlightRef = useRef(false);
  const resizeTeardownRef = useRef<((updateState: boolean) => void) | null>(
    null,
  );
  const currentSessionId = connection.sessionId;
  const projectName =
    getWorkspaceName(connection.workspaceCwd) || t('sidebar.projectFallback');
  const qwenCodeVersion = connection.capabilities?.qwenCodeVersion || '';
  // Numeric releases render as "v1.2.3"; a non-semver fallback such as
  // "unknown" is shown as-is so we never produce a bogus "vunknown".
  const versionLabel = qwenCodeVersion
    ? /^\d/.test(qwenCodeVersion)
      ? `v${qwenCodeVersion}`
      : qwenCodeVersion
    : '';
  const sidebarStyle = {
    '--web-shell-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;

  const cancelHideTooltip = useCallback(() => {
    if (tooltipHideTimer.current !== null) {
      window.clearTimeout(tooltipHideTimer.current);
      tooltipHideTimer.current = null;
    }
  }, []);

  const hideTooltip = useCallback(() => {
    cancelHideTooltip();
    tooltipHideTimer.current = window.setTimeout(() => {
      setTooltip(null);
      tooltipHideTimer.current = null;
    }, 240);
  }, [cancelHideTooltip]);

  useEffect(
    () => () => {
      cancelHideTooltip();
      resizeTeardownRef.current?.(false);
    },
    [cancelHideTooltip],
  );

  useEffect(() => {
    setProjectExpanded(!collapsed);
    if (collapsed) {
      setSearchOpen(false);
      setSearchQuery('');
      setTooltip(null);
    }
  }, [collapsed]);

  const hasRunningSession = useMemo(
    () => sessions.some((session) => session.hasActivePrompt),
    [sessions],
  );

  useEffect(() => {
    if (!projectExpanded && !hasRunningSession) return;
    const pollInterval =
      hasRunningSession && !error
        ? ACTIVE_SESSION_POLL_INTERVAL_MS
        : IDLE_SESSION_POLL_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      if (document.hidden || pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      void reload().finally(() => {
        pollInFlightRef.current = false;
      });
    }, pollInterval);
    return () => window.clearInterval(intervalId);
  }, [error, hasRunningSession, projectExpanded, reload]);

  useEffect(() => {
    const runningBySessionId = new Map(
      sessions.map((session) => [
        session.sessionId,
        Boolean(session.hasActivePrompt),
      ]),
    );
    const previousRunningBySessionId = previousRunningRef.current;
    previousRunningRef.current = runningBySessionId;
    if (previousRunningBySessionId === null) return;

    setCompletedUnreadIds((current) => {
      const next = new Set(current);
      let changed = false;

      for (const [sessionId, wasRunning] of previousRunningBySessionId) {
        const isRunning = runningBySessionId.get(sessionId);
        if (
          wasRunning &&
          isRunning === false &&
          sessionId !== currentSessionId &&
          !next.has(sessionId)
        ) {
          next.add(sessionId);
          changed = true;
        }
      }

      for (const sessionId of next) {
        if (
          sessionId === currentSessionId ||
          !runningBySessionId.has(sessionId) ||
          runningBySessionId.get(sessionId)
        ) {
          next.delete(sessionId);
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [currentSessionId, sessions]);

  const showTooltip = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactFocusEvent<HTMLElement>,
      content: ReactNode,
    ) => {
      cancelHideTooltip();
      const rect = event.currentTarget.getBoundingClientRect();
      setTooltip({
        content,
        top: rect.top + rect.height / 2,
        left: rect.right + 8,
      });
    },
    [cancelHideTooltip],
  );

  const renderSessionTooltip = useCallback(
    (session: DaemonSessionSummary) => {
      const label = getSessionLabel(session);
      const completedUnread =
        session.sessionId !== currentSessionId &&
        completedUnreadIds.has(session.sessionId);
      return (
        <div className={styles.tooltipContent}>
          <div className={styles.tooltipTitle}>{label}</div>
          <div className={styles.tooltipTags}>
            {session.hasActivePrompt && (
              <span className={cx(styles.tooltipTag, styles.tooltipTagRunning)}>
                {t('sidebar.running')}
              </span>
            )}
            {completedUnread && (
              <span className={cx(styles.tooltipTag, styles.tooltipTagNew)}>
                {t('sidebar.completedUnread')}
              </span>
            )}
            <span className={styles.tooltipTag}>
              {t('sidebar.clients', { count: session.clientCount ?? 0 })}
            </span>
          </div>
          <div className={styles.tooltipMeta}>{session.sessionId}</div>
        </div>
      );
    },
    [completedUnreadIds, currentSessionId, t],
  );

  const handleNewSession = useCallback(() => {
    if (busySessionIdRef.current !== null || creatingSessionRef.current) return;

    creatingSessionRef.current = true;
    void (async () => {
      try {
        const created = await onNewSession();
        if (created) {
          reload();
        }
      } catch (err) {
        if (!isAbortError(err)) {
          onError(err, t('sidebar.newSessionFailed'));
        }
      } finally {
        creatingSessionRef.current = false;
      }
    })();
  }, [onError, onNewSession, reload, t]);

  const handleLoadSession = useCallback(
    (sessionId: string) => {
      if (
        sessionId === currentSessionId ||
        sessionId === busySessionIdRef.current
      ) {
        return;
      }
      setCompletedUnreadIds((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      busySessionIdRef.current = sessionId;
      setBusySessionId(sessionId);
      void (async () => {
        try {
          await onLoadSession(sessionId);
        } catch (err) {
          if (!isAbortError(err)) {
            onError(err, t('sidebar.switchFailed'));
          }
        } finally {
          if (busySessionIdRef.current === sessionId) {
            busySessionIdRef.current = null;
          }
          setBusySessionId((current) =>
            current === sessionId ? null : current,
          );
        }
      })();
    },
    [currentSessionId, onError, onLoadSession, t],
  );

  const startRename = useCallback((session: DaemonSessionSummary) => {
    setEditingSessionId(session.sessionId);
    setEditingName(getSessionLabel(session));
  }, []);

  const cancelRename = useCallback(() => {
    setEditingSessionId(null);
    setEditingName('');
  }, []);

  const saveRename = useCallback(() => {
    const nextName = editingName.trim();
    if (!nextName || editingSessionId !== currentSessionId) {
      cancelRename();
      return;
    }
    const sessionId = editingSessionId;
    busySessionIdRef.current = sessionId;
    setBusySessionId(sessionId);
    actions
      .renameSession(nextName)
      .then(() => {
        cancelRename();
        reload();
      })
      .catch((err: unknown) => {
        onError(err, t('sidebar.renameFailed'));
        cancelRename();
      })
      .finally(() => {
        if (busySessionIdRef.current === sessionId) {
          busySessionIdRef.current = null;
        }
        setBusySessionId((current) => (current === sessionId ? null : current));
      });
  }, [
    actions,
    cancelRename,
    currentSessionId,
    editingName,
    editingSessionId,
    onError,
    reload,
    t,
  ]);

  const handleDeleteSession = useCallback(
    (session: DaemonSessionSummary) => {
      if (session.sessionId === currentSessionId) return;
      setDeleteCandidate(session);
    },
    [currentSessionId],
  );

  const confirmDeleteSession = useCallback(() => {
    if (!deleteCandidate) return;
    const sessionId = deleteCandidate.sessionId;
    if (sessionId === currentSessionId) {
      setDeleteCandidate(null);
      return;
    }
    setDeleteCandidate(null);
    busySessionIdRef.current = sessionId;
    setBusySessionId(sessionId);
    deleteSession(sessionId)
      .then((removed) => {
        if (!removed) reload();
      })
      .catch((err: unknown) => onError(err, t('sidebar.deleteFailed')))
      .finally(() => {
        if (busySessionIdRef.current === sessionId) {
          busySessionIdRef.current = null;
        }
        setBusySessionId((current) => (current === sessionId ? null : current));
      });
  }, [currentSessionId, deleteCandidate, deleteSession, onError, reload, t]);

  const handleRenameFromMenu = useCallback(
    (session: DaemonSessionSummary) => {
      if (session.sessionId !== currentSessionId) return;
      startRename(session);
    },
    [currentSessionId, startRename],
  );

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const nextSessions = query
      ? sessions.filter((session) => {
          const label = getSessionLabel(session).toLowerCase();
          return (
            label.includes(query) ||
            session.sessionId.toLowerCase().includes(query)
          );
        })
      : sessions.slice();
    const createdTimeById = new Map(
      nextSessions.map((session) => [
        session.sessionId,
        getSessionCreatedTime(session),
      ]),
    );
    return nextSessions.sort(
      (a, b) =>
        (createdTimeById.get(b.sessionId) ?? 0) -
        (createdTimeById.get(a.sessionId) ?? 0),
    );
  }, [searchQuery, sessions]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      resizeTeardownRef.current?.(true);
      setIsResizing(true);
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; window listeners still handle drag.
      }
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = clampSidebarWidth(
          startWidth + moveEvent.clientX - startX,
        );
        setSidebarWidth(nextWidth);
      };
      const teardown = (updateState: boolean) => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
        resizeTeardownRef.current = null;
        if (updateState) {
          setIsResizing(false);
        }
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        const nextWidth = clampSidebarWidth(
          startWidth + upEvent.clientX - startX,
        );
        setSidebarWidth(nextWidth);
        writeSidebarWidth(nextWidth);
        teardown(true);
      };
      const handlePointerCancel = () => {
        teardown(true);
      };
      resizeTeardownRef.current = teardown;
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
      window.addEventListener('pointercancel', handlePointerCancel, {
        once: true,
      });
    },
    [collapsed, sidebarWidth],
  );

  const deleteCandidateLabel = deleteCandidate
    ? getSessionLabel(deleteCandidate)
    : '';

  const body = useMemo(() => {
    if (!projectExpanded) return null;
    if (loading && sessions.length === 0) {
      return (
        <div className={styles.notice}>{t('sidebar.loadingSessions')}</div>
      );
    }
    if (error && sessions.length === 0) {
      return (
        <button className={styles.retry} type="button" onClick={reload}>
          {t('sidebar.loadFailed')}
        </button>
      );
    }
    if (filteredSessions.length === 0) {
      return <div className={styles.notice}>{t('sidebar.searchEmpty')}</div>;
    }
    return filteredSessions.map((session) => {
      const isCurrent = session.sessionId === currentSessionId;
      const isEditing = editingSessionId === session.sessionId;
      const label = getSessionLabel(session);
      const stamp = session.updatedAt || session.createdAt;
      const time = stamp ? formatRelativeTime(stamp, t) : '';
      const busy = busySessionId === session.sessionId;
      const completedUnread =
        !isCurrent && completedUnreadIds.has(session.sessionId);
      return (
        <div
          key={session.sessionId}
          className={cx(
            styles.sessionRow,
            isCurrent && styles.currentSession,
            session.hasActivePrompt && styles.runningSession,
            busy && styles.busySession,
          )}
          role="button"
          tabIndex={0}
          aria-current={isCurrent ? 'page' : undefined}
          onMouseEnter={(event) =>
            showTooltip(event, renderSessionTooltip(session))
          }
          onMouseLeave={hideTooltip}
          onFocus={(event) => showTooltip(event, renderSessionTooltip(session))}
          onBlur={hideTooltip}
          onClick={() => handleLoadSession(session.sessionId)}
          onDoubleClick={() => {
            if (isCurrent && !collapsed) startRename(session);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleLoadSession(session.sessionId);
          }}
        >
          {!collapsed && (
            <>
              <span className={styles.sessionStatusSlot} aria-hidden="true">
                {completedUnread && (
                  <span className={styles.sessionStatusDot} />
                )}
              </span>
              {isEditing ? (
                <form
                  className={styles.renameForm}
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveRename();
                  }}
                >
                  <input
                    autoFocus
                    className={styles.renameInput}
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onBlur={cancelRename}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                </form>
              ) : (
                <>
                  <span className={styles.sessionText}>{label}</span>
                  <div className={styles.sessionMetaSlot}>
                    {session.hasActivePrompt ? (
                      <span
                        className={styles.sessionLoading}
                        aria-label={t('sidebar.running')}
                      />
                    ) : (
                      <span className={styles.sessionTime}>{time}</span>
                    )}
                    <div
                      className={styles.sessionActions}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                      onMouseEnter={(event) => {
                        event.stopPropagation();
                        setTooltip(null);
                      }}
                    >
                      <button
                        className={styles.sessionActionButton}
                        type="button"
                        disabled={!isCurrent}
                        title={
                          isCurrent
                            ? t('sidebar.rename')
                            : t('sidebar.renameCurrentOnly')
                        }
                        aria-label={t('sidebar.rename')}
                        onClick={() => handleRenameFromMenu(session)}
                      >
                        <IconRename />
                      </button>
                      <button
                        className={styles.sessionActionButton}
                        type="button"
                        disabled={isCurrent}
                        title={
                          isCurrent
                            ? t('sidebar.currentDeleteDisabled')
                            : t('sidebar.delete')
                        }
                        aria-label={t('sidebar.delete')}
                        onClick={() => handleDeleteSession(session)}
                      >
                        <IconTrash />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      );
    });
  }, [
    busySessionId,
    cancelRename,
    collapsed,
    completedUnreadIds,
    currentSessionId,
    editingName,
    editingSessionId,
    error,
    filteredSessions,
    handleDeleteSession,
    handleLoadSession,
    handleRenameFromMenu,
    hideTooltip,
    loading,
    projectExpanded,
    reload,
    saveRename,
    renderSessionTooltip,
    sessions.length,
    showTooltip,
    startRename,
    t,
  ]);

  return (
    <aside
      className={cx(
        styles.sidebar,
        collapsed && styles.collapsed,
        isResizing && styles.resizing,
        mobileOpen && styles.mobileOpen,
      )}
      aria-label={t('sidebar.label')}
      style={sidebarStyle}
    >
      {tooltip && (
        <div
          className={styles.floatingTooltip}
          role="tooltip"
          style={{
            top: tooltip.top,
            left: tooltip.left,
          }}
          onMouseEnter={cancelHideTooltip}
          onMouseLeave={hideTooltip}
        >
          {tooltip.content}
        </div>
      )}
      {deleteCandidate && (
        <DialogShell
          title={t('delete.title')}
          size="sm"
          onClose={() => setDeleteCandidate(null)}
        >
          <div className={styles.confirmContent}>
            <p className={styles.confirmDescription}>
              {t('sidebar.deleteConfirmDescription', {
                name: deleteCandidateLabel,
              })}
            </p>
            <div className={styles.confirmActions}>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setDeleteCandidate(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.dangerButton}
                type="button"
                onClick={confirmDeleteSession}
              >
                {t('sidebar.delete')}
              </button>
            </div>
          </div>
        </DialogShell>
      )}
      <button
        className={styles.newChatButton}
        type="button"
        title={t('sidebar.newChat')}
        aria-label={t('sidebar.newChat')}
        onClick={handleNewSession}
      >
        <span className={styles.navIcon}>
          <IconNewChat />
        </span>
        {!collapsed && <span>{t('sidebar.newChat')}</span>}
      </button>

      <div className={styles.body}>
        {!collapsed && (
          <div className={styles.sectionTitle}>{t('sidebar.project')}</div>
        )}
        <div
          className={styles.projectRow}
          role="button"
          tabIndex={0}
          aria-expanded={projectExpanded}
          onClick={() => {
            if (!collapsed) {
              setProjectExpanded((expanded) => !expanded);
            }
          }}
          onKeyDown={(event) => {
            if (collapsed) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setProjectExpanded((expanded) => !expanded);
            }
          }}
          onMouseEnter={(event) =>
            showTooltip(
              event,
              <div className={styles.tooltipContent}>
                <div className={styles.tooltipTitle}>{projectName}</div>
                <div className={styles.tooltipMeta}>
                  {connection.workspaceCwd || projectName}
                </div>
              </div>,
            )
          }
          onMouseLeave={hideTooltip}
          onFocus={(event) =>
            showTooltip(
              event,
              <div className={styles.tooltipContent}>
                <div className={styles.tooltipTitle}>{projectName}</div>
                <div className={styles.tooltipMeta}>
                  {connection.workspaceCwd || projectName}
                </div>
              </div>,
            )
          }
          onBlur={hideTooltip}
        >
          <span className={`${styles.navIcon} ${styles.projectFolderIcon}`}>
            <IconFolder expanded={projectExpanded} />
          </span>
          {!collapsed && (
            <>
              <span className={styles.projectName}>{projectName}</span>
              <button
                className={styles.projectIconButton}
                type="button"
                aria-label={t('sidebar.search')}
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setSearchOpen((open) => {
                    if (open) {
                      setSearchQuery('');
                    }
                    return !open;
                  });
                  setProjectExpanded(true);
                }}
              >
                <IconSearch />
              </button>
              <button
                className={styles.projectIconButton}
                type="button"
                aria-label={
                  projectExpanded
                    ? t('sidebar.collapseProject')
                    : t('sidebar.expandProject')
                }
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  setProjectExpanded((expanded) => !expanded);
                }}
              >
                <IconChevron expanded={projectExpanded} />
              </button>
            </>
          )}
        </div>
        {searchOpen && !collapsed && projectExpanded && (
          <input
            className={styles.searchInput}
            value={searchQuery}
            placeholder={t('sidebar.searchPlaceholder')}
            aria-label={t('sidebar.search')}
            autoFocus
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchQuery('');
                setSearchOpen(false);
              }
            }}
          />
        )}
        <div className={styles.sessionList}>{body}</div>
      </div>

      <div className={styles.footer}>
        {onOpenDashboard && (
          <button
            className={styles.footerButton}
            type="button"
            title={t('sidebar.dashboard')}
            aria-label={t('sidebar.dashboard')}
            onClick={onOpenDashboard}
          >
            <span className={styles.navIcon}>
              <IconDashboard />
            </span>
            {!collapsed && <span>{t('sidebar.dashboard')}</span>}
          </button>
        )}
        <button
          className={styles.footerButton}
          type="button"
          title={t('sidebar.settings')}
          aria-label={t('sidebar.settings')}
          onClick={onOpenSettings}
        >
          <span className={`${styles.navIcon} ${styles.settingsIcon}`}>
            <IconSettings />
          </span>
          {!collapsed && <span>{t('sidebar.settings')}</span>}
        </button>
        {!collapsed && versionLabel && (
          <span className={styles.version} title={`Qwen Code ${versionLabel}`}>
            {versionLabel}
          </span>
        )}
        {!mobileOpen && (
          <button
            className={styles.collapseButton}
            type="button"
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            onClick={() => onCollapsedChange(!collapsed)}
          >
            <IconCollapse collapsed={collapsed} />
          </button>
        )}
      </div>
      <div
        className={styles.resizeHandle}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={handleResizePointerDown}
      />
    </aside>
  );
}

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
  useWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonSessionGroup,
  DaemonSessionGroupColor,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
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
const SESSION_ORGANIZATION_FEATURE = 'session_organization';
const DIALOG_SESSION_LABEL_MAX_LENGTH = 96;
const GROUP_MENU_WIDTH = 240;
const GROUP_MENU_MARGIN = 8;

type SessionGroupFilter = 'all' | 'pinned' | 'ungrouped' | string;
type GroupEditorMode = 'create' | 'edit';

interface GroupEditorState {
  mode: GroupEditorMode;
  group?: DaemonSessionGroup;
  targetSession?: DaemonSessionSummary;
}

interface GroupMenuState {
  session: DaemonSessionSummary;
  top: number;
  left: number;
}

interface WebShellSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onOpenDaemonStatus: () => void;
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

function getCompactSessionLabel(session: DaemonSessionSummary): string {
  const normalized = getSessionLabel(session).replace(/\s+/g, ' ').trim();
  if (normalized.length <= DIALOG_SESSION_LABEL_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized
    .slice(0, DIALOG_SESSION_LABEL_MAX_LENGTH - 3)
    .trimEnd()}...`;
}

function getSessionCreatedTime(session: DaemonSessionSummary): number {
  if (!session.createdAt) return 0;
  const time = Date.parse(session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

function isBuiltinGroupFilter(groupId: SessionGroupFilter): boolean {
  return groupId === 'all' || groupId === 'pinned' || groupId === 'ungrouped';
}

function getDefaultGroupColor(
  colorOptions: DaemonSessionGroupColor[],
): DaemonSessionGroupColor {
  return colorOptions[0] ?? 'blue';
}

function getGroupColorClass(
  color: DaemonSessionGroupColor,
): string | undefined {
  switch (color) {
    case 'red':
      return styles.groupColorRed;
    case 'orange':
      return styles.groupColorOrange;
    case 'yellow':
      return styles.groupColorYellow;
    case 'green':
      return styles.groupColorGreen;
    case 'blue':
      return styles.groupColorBlue;
    case 'purple':
      return styles.groupColorPurple;
  }
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

function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
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

function IconPin() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m14 4 6 6-4 1.5-3.5 3.5.5 4-8-8 4 .5 3.5-3.5L14 4Z" />
      <path d="m5 19 4.5-4.5" />
    </svg>
  );
}

function IconGroup() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10.5 12 5l8 5.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.5Z" />
      <path d="M9 20.5v-6h6v6" />
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
  onOpenDaemonStatus,
  onNewSession,
  onLoadSession,
  onError,
  mobileOpen,
}: WebShellSidebarProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const workspaceActions = useWorkspaceActions();
  const organizationEnabled = Boolean(
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE),
  );
  const [selectedGroupId, setSelectedGroupId] =
    useState<SessionGroupFilter>('all');
  const { sessions, loading, error, reload, deleteSession } = useSessions({
    autoLoad: true,
    pageSize: SIDEBAR_SESSION_PAGE_SIZE,
    ...(organizationEnabled
      ? { view: 'organized' as const, group: selectedGroupId }
      : {}),
  });
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [colorOptions, setColorOptions] = useState<DaemonSessionGroupColor[]>(
    [],
  );
  const [groupBusy, setGroupBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const busySessionIdRef = useRef<string | null>(null);
  const creatingSessionRef = useRef(false);
  const [deleteCandidate, setDeleteCandidate] =
    useState<DaemonSessionSummary | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupColor, setGroupColor] = useState<DaemonSessionGroupColor>('blue');
  const [deleteGroupCandidate, setDeleteGroupCandidate] =
    useState<DaemonSessionGroup | null>(null);
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
  const groupMenuRef = useRef<HTMLDivElement>(null);
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
  const selectedGroup = useMemo(
    () =>
      isBuiltinGroupFilter(selectedGroupId)
        ? undefined
        : groups.find((group) => group.id === selectedGroupId),
    [groups, selectedGroupId],
  );

  const reloadGroups = useCallback(async () => {
    if (!organizationEnabled) {
      setGroups([]);
      setColorOptions([]);
      return;
    }
    try {
      const catalog = await workspaceActions.listSessionGroups();
      setGroups(catalog.groups);
      setColorOptions(catalog.colorOptions);
    } catch (err) {
      onError(err, t('sidebar.groupsLoadFailed'));
    }
  }, [onError, organizationEnabled, t, workspaceActions]);

  useEffect(() => {
    if (!organizationEnabled) {
      setSelectedGroupId('all');
      setGroups([]);
      setColorOptions([]);
      return;
    }
    void reloadGroups();
  }, [organizationEnabled, reloadGroups]);

  useEffect(() => {
    if (
      organizationEnabled &&
      !isBuiltinGroupFilter(selectedGroupId) &&
      !groups.some((group) => group.id === selectedGroupId)
    ) {
      setSelectedGroupId('all');
    }
  }, [groups, organizationEnabled, selectedGroupId]);

  useEffect(() => {
    if (!groupMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (groupMenuRef.current?.contains(event.target as Node)) return;
      setGroupMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGroupMenu(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [groupMenu]);

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

  const handleCreateGroup = useCallback(() => {
    setGroupMenu(null);
    setGroupName('');
    setGroupColor(getDefaultGroupColor(colorOptions));
    setGroupEditor({ mode: 'create' });
  }, [colorOptions]);

  const handleCreateGroupForSession = useCallback(
    (session: DaemonSessionSummary) => {
      setGroupMenu(null);
      setGroupName('');
      setGroupColor(getDefaultGroupColor(colorOptions));
      setGroupEditor({ mode: 'create', targetSession: session });
    },
    [colorOptions],
  );

  const handleRenameGroup = useCallback(() => {
    if (!selectedGroup) return;
    setGroupName(selectedGroup.name);
    setGroupColor(selectedGroup.color);
    setGroupEditor({ mode: 'edit', group: selectedGroup });
  }, [selectedGroup]);

  const closeGroupEditor = useCallback(() => {
    if (groupBusy) return;
    setGroupEditor(null);
    setGroupName('');
    setGroupColor(getDefaultGroupColor(colorOptions));
  }, [colorOptions, groupBusy]);

  const saveGroupEditor = useCallback(() => {
    if (!groupEditor) return;
    const name = groupName.trim();
    if (!name) return;
    void (async () => {
      setGroupBusy(true);
      try {
        const group =
          groupEditor.mode === 'create'
            ? await workspaceActions.createSessionGroup({
                name,
                color: groupColor,
              })
            : await workspaceActions.updateSessionGroup(groupEditor.group!.id, {
                name,
                color: groupColor,
              });
        if (groupEditor.mode === 'create') {
          setSelectedGroupId(group.id);
          if (groupEditor.targetSession) {
            await workspaceActions.updateSessionOrganization(
              groupEditor.targetSession.sessionId,
              { groupId: group.id },
            );
            await reload();
          }
        }
        setGroupEditor(null);
        setGroupName('');
        await reloadGroups();
      } catch (err) {
        onError(
          err,
          groupEditor.mode === 'create' && groupEditor.targetSession
            ? t('sidebar.organizationFailed')
            : groupEditor.mode === 'create'
              ? t('sidebar.groupCreateFailed')
              : t('sidebar.groupUpdateFailed'),
        );
      } finally {
        setGroupBusy(false);
      }
    })();
  }, [
    groupColor,
    groupEditor,
    groupName,
    onError,
    reload,
    reloadGroups,
    t,
    workspaceActions,
  ]);

  const handleDeleteGroup = useCallback(() => {
    if (!selectedGroup) return;
    setDeleteGroupCandidate(selectedGroup);
  }, [selectedGroup]);

  const confirmDeleteGroup = useCallback(() => {
    if (!deleteGroupCandidate) return;
    setGroupBusy(true);
    workspaceActions
      .deleteSessionGroup(deleteGroupCandidate.id)
      .then(() => {
        setDeleteGroupCandidate(null);
        setSelectedGroupId('all');
        return reloadGroups();
      })
      .catch((err: unknown) => onError(err, t('sidebar.groupDeleteFailed')))
      .finally(() => setGroupBusy(false));
  }, [deleteGroupCandidate, onError, reloadGroups, t, workspaceActions]);

  const handleTogglePin = useCallback(
    (session: DaemonSessionSummary) => {
      if (!organizationEnabled || busySessionIdRef.current !== null) return;
      const sessionId = session.sessionId;
      busySessionIdRef.current = sessionId;
      setBusySessionId(sessionId);
      workspaceActions
        .updateSessionOrganization(sessionId, {
          isPinned: !session.isPinned,
        })
        .then(() => reload())
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          if (busySessionIdRef.current === sessionId) {
            busySessionIdRef.current = null;
          }
          setBusySessionId((current) =>
            current === sessionId ? null : current,
          );
        });
    },
    [onError, organizationEnabled, reload, t, workspaceActions],
  );

  const openGroupMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLButtonElement>,
      session: DaemonSessionSummary,
    ) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const viewportWidth =
        typeof window === 'undefined'
          ? rect.right + GROUP_MENU_WIDTH
          : window.innerWidth;
      const viewportHeight =
        typeof window === 'undefined' ? rect.top + 320 : window.innerHeight;
      const estimatedHeight = Math.min(320, 34 * (groups.length + 2) + 25);
      const left =
        rect.right + GROUP_MENU_MARGIN + GROUP_MENU_WIDTH <= viewportWidth
          ? rect.right + GROUP_MENU_MARGIN
          : Math.max(
              GROUP_MENU_MARGIN,
              rect.left - GROUP_MENU_WIDTH - GROUP_MENU_MARGIN,
            );
      const top = Math.max(
        GROUP_MENU_MARGIN,
        Math.min(
          rect.top,
          viewportHeight - estimatedHeight - GROUP_MENU_MARGIN,
        ),
      );
      setTooltip(null);
      setGroupMenu({
        session,
        top,
        left,
      });
    },
    [groups.length],
  );

  const assignSessionGroup = useCallback(
    (session: DaemonSessionSummary, groupId: string | null) => {
      if (!organizationEnabled || busySessionIdRef.current !== null) return;
      const sessionId = session.sessionId;
      setGroupMenu(null);
      busySessionIdRef.current = sessionId;
      setBusySessionId(sessionId);
      workspaceActions
        .updateSessionOrganization(sessionId, { groupId })
        .then(() => reload())
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          if (busySessionIdRef.current === sessionId) {
            busySessionIdRef.current = null;
          }
          setBusySessionId((current) =>
            current === sessionId ? null : current,
          );
        });
    },
    [onError, organizationEnabled, reload, t, workspaceActions],
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
    if (organizationEnabled) {
      return nextSessions;
    }
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
  }, [organizationEnabled, searchQuery, sessions]);

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
    ? getCompactSessionLabel(deleteCandidate)
    : '';
  const groupMenuSelectedGroupId =
    groupMenu?.session.groupId &&
    groups.some((group) => group.id === groupMenu.session.groupId)
      ? groupMenu.session.groupId
      : null;
  const deleteGroupCandidateLabel = deleteGroupCandidate?.name ?? '';
  const canSaveGroup = groupName.trim().length > 0 && !groupBusy;
  const groupEditorTitle =
    groupEditor?.mode === 'create'
      ? t('sidebar.groupCreate')
      : t('sidebar.groupRename');
  const groupColorChoices =
    colorOptions.length > 0
      ? colorOptions
      : (['blue'] as DaemonSessionGroupColor[]);

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
            session.isPinned && styles.pinnedSession,
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
                {!completedUnread && session.isPinned && (
                  <span className={styles.sessionPinMarker}>
                    <IconPin />
                  </span>
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
                      {organizationEnabled && (
                        <>
                          <button
                            className={cx(
                              styles.sessionActionButton,
                              session.isPinned &&
                                styles.activeSessionActionButton,
                            )}
                            type="button"
                            disabled={busy}
                            title={
                              session.isPinned
                                ? t('sidebar.unpin')
                                : t('sidebar.pin')
                            }
                            aria-label={
                              session.isPinned
                                ? t('sidebar.unpin')
                                : t('sidebar.pin')
                            }
                            onClick={() => handleTogglePin(session)}
                          >
                            <IconPin />
                          </button>
                          <button
                            className={styles.sessionActionButton}
                            type="button"
                            disabled={busy}
                            title={t('sidebar.organize')}
                            aria-label={t('sidebar.organize')}
                            onClick={(event) => openGroupMenu(event, session)}
                          >
                            <IconGroup />
                          </button>
                        </>
                      )}
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
    handleTogglePin,
    hideTooltip,
    loading,
    openGroupMenu,
    organizationEnabled,
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
      {groupMenu && (
        <div
          ref={groupMenuRef}
          className={styles.groupMenu}
          role="menu"
          aria-label={t('sidebar.sessionGroup')}
          style={{ top: groupMenu.top, left: groupMenu.left }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className={cx(
              styles.groupMenuItem,
              groupMenuSelectedGroupId === null && styles.groupMenuItemActive,
            )}
            type="button"
            role="menuitemradio"
            aria-checked={groupMenuSelectedGroupId === null}
            onClick={() => assignSessionGroup(groupMenu.session, null)}
          >
            <span className={styles.groupMenuEmptyDot} />
            <span className={styles.groupMenuName}>
              {t('sidebar.groupUngrouped')}
            </span>
            {groupMenuSelectedGroupId === null && (
              <span className={styles.groupMenuCheck}>✓</span>
            )}
          </button>
          {groups.map((group) => {
            const selected = groupMenuSelectedGroupId === group.id;
            return (
              <button
                key={group.id}
                className={cx(
                  styles.groupMenuItem,
                  selected && styles.groupMenuItemActive,
                )}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => assignSessionGroup(groupMenu.session, group.id)}
              >
                <span
                  className={cx(
                    styles.groupMenuDot,
                    getGroupColorClass(group.color),
                  )}
                />
                <span className={styles.groupMenuName}>{group.name}</span>
                {selected && <span className={styles.groupMenuCheck}>✓</span>}
              </button>
            );
          })}
          <div className={styles.groupMenuSeparator} />
          <button
            className={styles.groupMenuItem}
            type="button"
            role="menuitem"
            onClick={() => handleCreateGroupForSession(groupMenu.session)}
          >
            <span className={styles.groupMenuIcon}>
              <IconNewChat />
            </span>
            <span className={styles.groupMenuName}>
              {t('sidebar.groupCreate')}
            </span>
          </button>
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
      {groupEditor && (
        <DialogShell
          title={groupEditorTitle}
          size="sm"
          onClose={closeGroupEditor}
        >
          <form
            className={styles.groupForm}
            onSubmit={(event) => {
              event.preventDefault();
              saveGroupEditor();
            }}
          >
            <label className={styles.fieldStack}>
              <span>{t('sidebar.groupNamePrompt')}</span>
              <input
                className={styles.dialogInput}
                value={groupName}
                autoFocus
                maxLength={64}
                onChange={(event) => setGroupName(event.target.value)}
              />
            </label>
            <label className={styles.fieldStack}>
              <span>{t('sidebar.groupColor')}</span>
              <select
                className={styles.dialogSelect}
                value={groupColor}
                onChange={(event) =>
                  setGroupColor(event.target.value as DaemonSessionGroupColor)
                }
              >
                {groupColorChoices.map((color) => (
                  <option key={color} value={color}>
                    {t(`sidebar.groupColor.${color}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.confirmActions}>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={groupBusy}
                onClick={closeGroupEditor}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.secondaryButton}
                type="submit"
                disabled={!canSaveGroup}
              >
                {t('common.save')}
              </button>
            </div>
          </form>
        </DialogShell>
      )}
      {deleteGroupCandidate && (
        <DialogShell
          title={t('sidebar.groupDelete')}
          size="sm"
          onClose={() => {
            if (!groupBusy) setDeleteGroupCandidate(null);
          }}
        >
          <div className={styles.confirmContent}>
            <p className={styles.confirmDescription}>
              {t('sidebar.groupDeleteConfirm', {
                name: deleteGroupCandidateLabel,
              })}
            </p>
            <div className={styles.confirmActions}>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={groupBusy}
                onClick={() => setDeleteGroupCandidate(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className={styles.dangerButton}
                type="button"
                disabled={groupBusy}
                onClick={confirmDeleteGroup}
              >
                {t('sidebar.groupDelete')}
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
        {organizationEnabled && !collapsed && projectExpanded && (
          <div className={styles.groupToolbar}>
            <select
              className={styles.groupSelect}
              value={selectedGroupId}
              aria-label={t('sidebar.groupFilter')}
              disabled={groupBusy}
              onChange={(event) =>
                setSelectedGroupId(event.target.value as SessionGroupFilter)
              }
            >
              <option value="all">{t('sidebar.groupAll')}</option>
              <option value="pinned">{t('sidebar.groupPinned')}</option>
              <option value="ungrouped">{t('sidebar.groupUngrouped')}</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <button
              className={cx(styles.projectIconButton, styles.groupIconButton)}
              type="button"
              disabled={groupBusy}
              title={t('sidebar.groupCreate')}
              aria-label={t('sidebar.groupCreate')}
              onClick={handleCreateGroup}
            >
              <IconNewChat />
            </button>
            {selectedGroup && (
              <>
                <button
                  className={cx(
                    styles.projectIconButton,
                    styles.groupIconButton,
                  )}
                  type="button"
                  disabled={groupBusy}
                  title={t('sidebar.groupRename')}
                  aria-label={t('sidebar.groupRename')}
                  onClick={handleRenameGroup}
                >
                  <IconRename />
                </button>
                <button
                  className={cx(
                    styles.projectIconButton,
                    styles.groupIconButton,
                  )}
                  type="button"
                  disabled={groupBusy}
                  title={t('sidebar.groupDelete')}
                  aria-label={t('sidebar.groupDelete')}
                  onClick={handleDeleteGroup}
                >
                  <IconTrash />
                </button>
              </>
            )}
          </div>
        )}
        <div className={styles.sessionList}>{body}</div>
      </div>

      <div className={styles.footer}>
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
        <button
          className={styles.collapseButton}
          type="button"
          title={t('sidebar.daemonStatus')}
          aria-label={t('sidebar.daemonStatus')}
          onClick={onOpenDaemonStatus}
        >
          <IconPulse />
        </button>
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

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  useActions,
  useConnection,
  useSessions,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/webui/daemon-react-sdk';
import type {
  DaemonSessionGroup,
  DaemonSessionGroupColor,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  ActivityIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  LayoutGridIcon,
  InfoIcon,
  EllipsisVerticalIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  DownloadIcon,
  FolderInputIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
} from 'lucide-react';
import { WebShellThemeId, type WebShellTheme } from '../../themeContext';
import { useI18n } from '../../i18n';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { DialogShell } from '../dialogs/DialogShell';
import { AddWorkspaceDialog } from '../dialogs/AddWorkspaceDialog';
import { WorkspaceSection } from './WorkspaceSection';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_ORGANIZATION_FEATURE,
} from '../../constants/sessions';
import styles from './WebShellSidebar.module.css';

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_FOOTER_COMPACT_WIDTH = 344;
const SIDEBAR_FOOTER_TIGHT_WIDTH = 250;
const SIDEBAR_DRAG_VISUAL_MIN_WIDTH = 200;
const SIDEBAR_COLLAPSE_DRAG_THRESHOLD = 56;
const SIDEBAR_COLLAPSE_DRAG_WIDTH =
  SIDEBAR_DRAG_VISUAL_MIN_WIDTH - SIDEBAR_COLLAPSE_DRAG_THRESHOLD;
const ACTIVE_SESSION_POLL_INTERVAL_MS = 2000;
const IDLE_SESSION_POLL_INTERVAL_MS = 30_000;
const DIALOG_SESSION_LABEL_MAX_LENGTH = 96;
const RECENT_SESSION_SECTION_ID = 'recent';
const GROUP_MENU_WIDTH = 240;
const GROUP_MENU_MARGIN = 8;

/**
 * Palette order for the quick color-grouping buckets. Mirrors core's
 * `GROUP_COLOR_OPTIONS`; kept as a local constant so the client never imports
 * from core. Used both to order the color sections and as a fallback when the
 * daemon's color catalog has not loaded yet.
 */
const SESSION_GROUP_COLORS: DaemonSessionGroupColor[] = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
];

type GroupEditorMode = 'create' | 'edit';

type SessionSectionKind = 'color' | 'group' | 'recent';

interface SessionSection {
  id: string;
  kind: SessionSectionKind;
  label: string;
  countLabel?: string;
  color?: DaemonSessionGroupColor;
  group?: DaemonSessionGroup;
  sessions: DaemonSessionSummary[];
}

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
  onOpenScheduledTasks: () => void;
  onOpenSessions: () => void;
  /**
   * Whether to offer the Session Overview entry point. Gated to large screens
   * by the app: below that there is no room to make managing several sessions
   * side by side worthwhile.
   */
  canOpenSessionsOverview?: boolean;
  onOpenSplitView: () => void;
  /** Whether to offer the in-window split view (large screens only). */
  canOpenSplitView?: boolean;
  onNewSession: (workspaceCwd?: string) => Promise<boolean> | boolean;
  onLoadSession: (
    sessionId: string,
    workspaceCwd?: string,
  ) => Promise<void> | void;
  onError: (error: unknown, fallback: string) => void;
  theme: WebShellTheme;
  onThemeChange: (theme: WebShellTheme) => void;
  mobileOpen?: boolean;
  sessionListReloadToken?: number;
  /**
   * Phase 4: workspace cwd picked for the next new session (undefined =
   * primary). Only meaningful on multi-workspace daemons.
   */
  selectedWorkspaceCwd?: string;
  onSelectWorkspace?: (workspaceCwd: string | undefined) => void;
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

function getDefaultGroupColor(
  colorOptions: DaemonSessionGroupColor[],
): DaemonSessionGroupColor {
  return colorOptions[0] ?? 'blue';
}

function getGroupColorClass(color: DaemonSessionGroupColor): string {
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
  const exhaustive: never = color;
  return exhaustive;
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function clampSidebarVisualWidth(width: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_DRAG_VISUAL_MIN_WIDTH, width),
  );
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

/**
 * Qwen brand mark. Same artwork as the browser-tab favicon in index.html and
 * the QwenLM GitHub avatar; inlined as an SVG rather than hot-linked because
 * the Web Shell CSP is `img-src 'self' data: blob:` (see web-shell-static.ts),
 * which blocks remote images. The purple #6D44E8 fill is legible on both the
 * light and dark sidebar backgrounds. Filled (not stroked) so it opts out of
 * the shared `.navIcon svg` stroke styling.
 */
function IconQwenLogo() {
  return (
    <svg viewBox="0 0 141.38 140" aria-hidden="true">
      <path
        fill="#6D44E8"
        d="m140.93 85-16.35-28.33-1.93-3.34 8.66-15a3.323 3.323 0 0 0 0-3.34l-9.62-16.67c-.3-.51-.72-.93-1.22-1.22s-1.07-.45-1.67-.45H82.23l-8.66-15a3.33 3.33 0 0 0-2.89-1.67H51.43c-.59 0-1.17.16-1.66.45-.5.29-.92.71-1.22 1.22L32.19 29.98l-1.92 3.33H12.96c-.59 0-1.17.16-1.66.45-.5.29-.93.71-1.22 1.22L.45 51.66a3.323 3.323 0 0 0 0 3.34l18.28 31.67-8.66 15a3.32 3.32 0 0 0 0 3.34l9.62 16.67c.3.51.72.93 1.22 1.22s1.07.45 1.67.45h36.56l8.66 15a3.35 3.35 0 0 0 2.89 1.67h19.25a3.34 3.34 0 0 0 2.89-1.67l18.28-31.67h17.32c.6 0 1.17-.16 1.67-.45s.92-.71 1.22-1.22l9.62-16.67a3.323 3.323 0 0 0 0-3.34ZM51.44 3.33 61.07 20l-9.63 16.66h76.98l-9.62 16.66H45.67l-11.54-20zM57.21 120H22.58l9.63-16.67h19.25l-38.5-66.67h19.25l9.62 16.67L68.78 100l-11.55 20Zm61.59-33.34-9.62-16.67-38.49 66.67-9.63-16.67 9.63-16.66 26.94-46.67h23.1l17.32 30z"
      />
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
  onOpenScheduledTasks,
  onOpenSessions,
  canOpenSessionsOverview,
  onOpenSplitView,
  canOpenSplitView,
  onNewSession,
  onLoadSession,
  onError,
  theme,
  onThemeChange,
  mobileOpen,
  sessionListReloadToken,
  selectedWorkspaceCwd,
  onSelectWorkspace,
}: WebShellSidebarProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const workspaceActions = useWorkspaceActions();
  const workspace = useWorkspace();
  const organizationEnabled = Boolean(
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE),
  );
  // Phase 4: registered workspaces on a multi-workspace daemon (absent or a
  // single entry otherwise). Drives the new-session workspace picker.
  const workspaces = useMemo(
    () => workspace.capabilities?.workspaces ?? [],
    [workspace.capabilities?.workspaces],
  );
  const {
    sessions,
    loading,
    error,
    reload,
    deleteSession,
    exportSession,
    archiveSession,
  } = useSessions({
    autoLoad: true,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const {
    sessions: archivedSessions,
    loading: archivedLoading,
    error: archivedError,
    reload: reloadArchived,
    deleteSession: deleteArchivedSession,
    unarchiveSession,
  } = useSessions({
    autoLoad: true,
    enabled: archivedExpanded,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'archived',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [colorOptions, setColorOptions] = useState<DaemonSessionGroupColor[]>(
    [],
  );
  const [groupBusy, setGroupBusy] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const busySessionIdsRef = useRef<Set<string>>(new Set());
  const [exportingSessionIds, setExportingSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const exportingSessionIdsRef = useRef<Set<string>>(new Set());
  const [creatingSession, setCreatingSession] = useState(false);
  const creatingSessionRef = useRef(false);
  const [deleteCandidate, setDeleteCandidate] =
    useState<DaemonSessionSummary | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupColor, setGroupColor] = useState<DaemonSessionGroupColor>('blue');
  const [deleteGroupCandidate, setDeleteGroupCandidate] =
    useState<DaemonSessionGroup | null>(null);
  const [collapsedSessionSectionIds, setCollapsedSessionSectionIds] = useState<
    Set<string>
  >(() => new Set());
  const knownSessionSectionIdsRef = useRef<Set<string>>(new Set());
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [projectExpanded, setProjectExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] = useState(false);
  const [workspaceSessionsReloadToken, setWorkspaceSessionsReloadToken] =
    useState(0);
  const [autoExpandWorkspace, setAutoExpandWorkspace] = useState<{
    id: string;
    key: string;
  } | null>(null);
  // Bump the token WorkspaceSection instances watch, so the per-workspace
  // session lists re-poll immediately after a mutation instead of waiting for
  // their 10s interval. Stable identity — safe (and required) in consumer deps.
  const bumpWorkspaceReload = useCallback(() => {
    setWorkspaceSessionsReloadToken((v) => v + 1);
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [isResizing, setIsResizing] = useState(false);
  const [completedUnreadIds, setCompletedUnreadIds] = useState<Set<string>>(
    () => new Set(),
  );
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuPointerDismissRef = useRef(false);
  const previousRunningRef = useRef<Map<string, boolean> | null>(null);
  const autoOpenedContextRef = useRef<string | null>(null);
  const pollInFlightRef = useRef(false);
  const resizeTeardownRef = useRef<((updateState: boolean) => void) | null>(
    null,
  );
  const currentSessionId = connection.sessionId;
  const canExportSessions =
    connection.capabilities?.features?.includes('session_export') ?? false;
  const projectName =
    getWorkspaceName(connection.workspaceCwd) || t('sidebar.projectFallback');
  const displayedWorkspaces = useMemo<DaemonWorkspaceCapability[]>(
    () =>
      workspaces.length > 0
        ? workspaces
        : [
            {
              id: 'primary',
              cwd: connection.workspaceCwd || projectName,
              primary: true,
              trusted: true,
            },
          ],
    [connection.workspaceCwd, projectName, workspaces],
  );
  const qwenCodeVersion = connection.capabilities?.qwenCodeVersion || '';
  // Numeric releases render as "v1.2.3"; a non-semver fallback such as
  // "unknown" is shown as-is so we never produce a bogus "vunknown".
  const versionLabel = qwenCodeVersion
    ? /^\d/.test(qwenCodeVersion)
      ? `v${qwenCodeVersion}`
      : qwenCodeVersion
    : '';
  const footerCompact =
    !collapsed && sidebarWidth < SIDEBAR_FOOTER_COMPACT_WIDTH;
  const footerTight = !collapsed && sidebarWidth < SIDEBAR_FOOTER_TIGHT_WIDTH;
  const sidebarStyle = {
    '--web-shell-sidebar-width': `${sidebarWidth}px`,
  } as CSSProperties;
  const newSessionDisabled = creatingSession;

  useEffect(() => {
    if (!currentSessionId) return;
    const activeWorkspace =
      displayedWorkspaces.find(
        (entry) => entry.cwd === connection.workspaceCwd,
      ) ??
      (displayedWorkspaces.length === 1 && displayedWorkspaces[0]?.primary
        ? displayedWorkspaces[0]
        : undefined);
    if (!activeWorkspace) return;
    const contextKey = `session:${currentSessionId}:${activeWorkspace.id}`;
    if (autoOpenedContextRef.current === contextKey) return;
    autoOpenedContextRef.current = contextKey;
    setProjectsExpanded(true);
    if (activeWorkspace.primary) {
      setProjectExpanded(true);
    } else {
      setAutoExpandWorkspace({ id: activeWorkspace.id, key: contextKey });
    }
  }, [connection.workspaceCwd, currentSessionId, displayedWorkspaces]);

  useEffect(() => {
    if (currentSessionId || selectedWorkspaceCwd !== undefined) {
      return;
    }
    if (!workspace.capabilities) return;
    const connectedWorkspace = workspaces.find(
      (entry) => entry.cwd === connection.workspaceCwd,
    );
    const contextKey = `new:${connectedWorkspace?.id ?? 'primary'}`;
    if (autoOpenedContextRef.current === contextKey) return;
    autoOpenedContextRef.current = contextKey;
    setProjectsExpanded(true);
    if (connectedWorkspace && !connectedWorkspace.primary) {
      setProjectExpanded(false);
      setAutoExpandWorkspace({
        id: connectedWorkspace.id,
        key: contextKey,
      });
      onSelectWorkspace?.(connectedWorkspace.cwd);
      return;
    }
    setProjectExpanded(true);
  }, [
    connection.workspaceCwd,
    currentSessionId,
    onSelectWorkspace,
    selectedWorkspaceCwd,
    workspace.capabilities,
    workspaces,
  ]);

  const setSessionBusy = useCallback((sessionId: string, busy: boolean) => {
    const next = new Set(busySessionIdsRef.current);
    if (busy) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    busySessionIdsRef.current = next;
    setBusySessionIds(next);
  }, []);

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
      setGroups([]);
      setColorOptions([]);
      return;
    }
    void reloadGroups();
  }, [organizationEnabled, reloadGroups]);

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

  useEffect(() => {
    if (!groupMenu) return;
    const animationFrame = window.requestAnimationFrame(() => {
      const items = Array.from(
        groupMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)',
        ) ?? [],
      );
      const selected =
        items.find((item) => item.getAttribute('aria-checked') === 'true') ??
        items[0];
      selected?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [groupMenu]);

  const handleGroupMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        groupMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)',
        ) ?? [],
      );
      if (items.length === 0) return;
      const activeIndex = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const currentIndex = activeIndex >= 0 ? activeIndex : -1;
      let nextIndex: number | undefined;
      if (event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = items.length - 1;
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setGroupMenu(null);
        return;
      }
      if (nextIndex === undefined) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    },
    [],
  );

  useEffect(
    () => () => {
      resizeTeardownRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    if (collapsed) {
      setProjectExpanded(false);
      setSearchOpen(false);
      setSearchQuery('');
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

  const prevReloadTokenRef = useRef(sessionListReloadToken);
  useEffect(() => {
    if (
      sessionListReloadToken !== undefined &&
      sessionListReloadToken !== prevReloadTokenRef.current &&
      !document.hidden &&
      !pollInFlightRef.current
    ) {
      prevReloadTokenRef.current = sessionListReloadToken;
      pollInFlightRef.current = true;
      void reload().finally(() => {
        pollInFlightRef.current = false;
      });
    }
  }, [sessionListReloadToken, reload]);

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

  const handleAddWorkspace = useCallback(
    async (cwd: string, persist: boolean) => {
      const result = await workspaceActions.addWorkspace(cwd, { persist });
      if (persist && result.persisted !== true) {
        throw new Error(t('sidebar.addWorkspacePersistenceError'));
      }
      // Force a fresh capabilities fetch so the new workspace appears
      // immediately. Best-effort: registration already succeeded, so a
      // refresh failure must not surface as an add-workspace error — the
      // next reload reconciles. (The former `getCapabilities?.()` was a
      // no-op: it returns a cached promise and never updates state.)
      try {
        await workspace.refreshCapabilities?.();
      } catch {
        // ignore — the workspace is registered; the list reconciles on reload
      }
    },
    [t, workspaceActions, workspace],
  );

  const handleNewSession = useCallback(
    (workspaceCwd?: string) => {
      if (creatingSessionRef.current) return;

      creatingSessionRef.current = true;
      setCreatingSession(true);
      void (async () => {
        try {
          const created = await onNewSession(workspaceCwd);
          if (created) {
            void reload().catch(() => undefined);
            bumpWorkspaceReload();
          }
        } catch (err) {
          if (!isAbortError(err)) {
            onError(err, t('sidebar.newSessionFailed'));
          }
        } finally {
          creatingSessionRef.current = false;
          setCreatingSession(false);
        }
      })();
    },
    [bumpWorkspaceReload, onError, onNewSession, reload, t],
  );

  const handleLoadSession = useCallback(
    (sessionId: string, workspaceCwd?: string) => {
      if (
        sessionId === currentSessionId ||
        busySessionIdsRef.current.has(sessionId)
      ) {
        return;
      }
      setCompletedUnreadIds((current) => {
        if (!current.has(sessionId)) return current;
        const next = new Set(current);
        next.delete(sessionId);
        return next;
      });
      setSessionBusy(sessionId, true);
      void (async () => {
        try {
          await onLoadSession(sessionId, workspaceCwd);
        } catch (err) {
          if (!isAbortError(err)) {
            onError(err, t('sidebar.switchFailed'));
          }
        } finally {
          setSessionBusy(sessionId, false);
        }
      })();
    },
    [currentSessionId, onError, onLoadSession, setSessionBusy, t],
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
    if (busySessionIdsRef.current.has(sessionId)) return;
    setSessionBusy(sessionId, true);
    actions
      .renameSession(nextName)
      .then(() => {
        cancelRename();
        reload();
        bumpWorkspaceReload();
      })
      .catch((err: unknown) => {
        onError(err, t('sidebar.renameFailed'));
        cancelRename();
      })
      .finally(() => {
        setSessionBusy(sessionId, false);
      });
  }, [
    actions,
    bumpWorkspaceReload,
    cancelRename,
    currentSessionId,
    editingName,
    editingSessionId,
    onError,
    reload,
    setSessionBusy,
    t,
  ]);

  const handleDeleteSession = useCallback(
    (session: DaemonSessionSummary) => {
      if (session.sessionId === currentSessionId) return;
      setDeleteCandidate(session);
    },
    [currentSessionId],
  );

  const setSessionExporting = useCallback(
    (sessionId: string, exporting: boolean) => {
      const next = new Set(exportingSessionIdsRef.current);
      if (exporting) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      exportingSessionIdsRef.current = next;
      setExportingSessionIds(next);
    },
    [],
  );

  const handleExportSession = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      if (!canExportSessions || exportingSessionIdsRef.current.has(sessionId)) {
        return;
      }
      setSessionExporting(sessionId, true);
      void (async () => {
        try {
          const result = await exportSession(sessionId, 'html');
          const blob = new Blob([result.content], {
            type: result.mimeType || 'text/html',
          });
          const url = URL.createObjectURL(blob);
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
        } catch (err) {
          onError(err, t('sidebar.exportFailed'));
        } finally {
          setSessionExporting(sessionId, false);
        }
      })();
    },
    [canExportSessions, exportSession, onError, setSessionExporting, t],
  );

  const confirmDeleteSession = useCallback(() => {
    if (!deleteCandidate) return;
    const sessionId = deleteCandidate.sessionId;
    if (sessionId === currentSessionId) {
      setDeleteCandidate(null);
      return;
    }
    const isArchived = Boolean(deleteCandidate.isArchived);
    setDeleteCandidate(null);
    if (busySessionIdsRef.current.has(sessionId)) return;
    setSessionBusy(sessionId, true);
    const removeSession = isArchived ? deleteArchivedSession : deleteSession;
    removeSession(sessionId)
      .then(() => {
        // A hard delete unlinks the transcript from BOTH the active and
        // archived directories, so resync both lists regardless of origin.
        void reload();
        void reloadArchived();
        bumpWorkspaceReload();
      })
      .catch((err: unknown) => onError(err, t('sidebar.deleteFailed')))
      .finally(() => {
        setSessionBusy(sessionId, false);
      });
  }, [
    bumpWorkspaceReload,
    currentSessionId,
    deleteArchivedSession,
    deleteCandidate,
    deleteSession,
    onError,
    reload,
    reloadArchived,
    setSessionBusy,
    t,
  ]);

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

  const handleRenameGroup = useCallback((group: DaemonSessionGroup) => {
    setGroupName(group.name);
    setGroupColor(group.color);
    setGroupEditor({ mode: 'edit', group });
  }, []);

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
          if (groupEditor.targetSession) {
            try {
              await workspaceActions.updateSessionOrganization(
                groupEditor.targetSession.sessionId,
                // Assigning a named group clears any color tag (single choice
                // in the UI), matching assignSessionGroup.
                { groupId: group.id, color: null },
              );
              void reload().catch(() => undefined);
              bumpWorkspaceReload();
            } catch (err) {
              setGroupEditor(null);
              setGroupName('');
              void reloadGroups().catch(() => undefined);
              onError(err, t('sidebar.groupAssignFailedAfterCreate'));
              return;
            }
          }
        }
        setGroupEditor(null);
        setGroupName('');
        void reloadGroups().catch(() => undefined);
      } catch (err) {
        onError(
          err,
          groupEditor.mode === 'create'
            ? t('sidebar.groupCreateFailed')
            : t('sidebar.groupUpdateFailed'),
        );
      } finally {
        setGroupBusy(false);
      }
    })();
  }, [
    bumpWorkspaceReload,
    groupColor,
    groupEditor,
    groupName,
    onError,
    reload,
    reloadGroups,
    t,
    workspaceActions,
  ]);

  const handleDeleteGroup = useCallback((group: DaemonSessionGroup) => {
    setDeleteGroupCandidate(group);
  }, []);

  const confirmDeleteGroup = useCallback(() => {
    if (!deleteGroupCandidate) return;
    setGroupBusy(true);
    workspaceActions
      .deleteSessionGroup(deleteGroupCandidate.id)
      .then(() => {
        setDeleteGroupCandidate(null);
        void reload().catch(() => undefined);
      })
      .catch((err: unknown) => onError(err, t('sidebar.groupDeleteFailed')))
      .then(() => reloadGroups().catch(() => undefined))
      .finally(() => setGroupBusy(false));
  }, [
    deleteGroupCandidate,
    onError,
    reload,
    reloadGroups,
    t,
    workspaceActions,
  ]);

  const handleTogglePin = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      if (!organizationEnabled || busySessionIdsRef.current.has(sessionId)) {
        return;
      }
      setSessionBusy(sessionId, true);
      workspaceActions
        .updateSessionOrganization(sessionId, {
          isPinned: !session.isPinned,
        })
        .then(() => {
          void reload().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false);
        });
    },
    [
      bumpWorkspaceReload,
      onError,
      organizationEnabled,
      reload,
      setSessionBusy,
      t,
      workspaceActions,
    ],
  );

  const handleArchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      // The daemon force-ends a live turn on archive; keep the current
      // session off-limits, mirroring the delete guard.
      if (sessionId === currentSessionId) return;
      if (busySessionIdsRef.current.has(sessionId)) return;
      setSessionBusy(sessionId, true);
      archiveSession(sessionId)
        .then(() => {
          void reloadArchived();
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.archiveFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false);
        });
    },
    [
      archiveSession,
      bumpWorkspaceReload,
      currentSessionId,
      onError,
      reloadArchived,
      setSessionBusy,
      t,
    ],
  );

  const handleUnarchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      if (busySessionIdsRef.current.has(sessionId)) return;
      setSessionBusy(sessionId, true);
      unarchiveSession(sessionId)
        .then(() => {
          void reload();
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.unarchiveFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false);
        });
    },
    [bumpWorkspaceReload, onError, reload, setSessionBusy, t, unarchiveSession],
  );

  const openGroupMenuFromAnchor = useCallback(
    (anchorEl: HTMLElement, session: DaemonSessionSummary) => {
      const rect = anchorEl.getBoundingClientRect();
      const viewportWidth =
        typeof window === 'undefined'
          ? rect.right + GROUP_MENU_WIDTH
          : window.innerWidth;
      const viewportHeight =
        typeof window === 'undefined' ? rect.top + 320 : window.innerHeight;
      const estimatedHeight = Math.min(
        320,
        34 * (groups.length + SESSION_GROUP_COLORS.length + 2) + 25,
      );
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
      const sessionId = session.sessionId;
      if (!organizationEnabled || busySessionIdsRef.current.has(sessionId)) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true);
      workspaceActions
        // Group and color are a single choice in the UI: assigning a named
        // group (or "Ungrouped", groupId=null) clears any color tag.
        .updateSessionOrganization(sessionId, { groupId, color: null })
        .then(() => {
          void reload().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false);
        });
    },
    [
      bumpWorkspaceReload,
      onError,
      organizationEnabled,
      reload,
      setSessionBusy,
      t,
      workspaceActions,
    ],
  );

  const assignSessionColor = useCallback(
    (session: DaemonSessionSummary, color: DaemonSessionGroupColor | null) => {
      const sessionId = session.sessionId;
      if (!organizationEnabled || busySessionIdsRef.current.has(sessionId)) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true);
      workspaceActions
        // Picking a color clears any named-group assignment (single choice).
        .updateSessionOrganization(sessionId, { color, groupId: null })
        .then(() => {
          void reload().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false);
        });
    },
    [
      bumpWorkspaceReload,
      onError,
      organizationEnabled,
      reload,
      setSessionBusy,
      t,
      workspaceActions,
    ],
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

  const sessionSections = useMemo<SessionSection[]>(() => {
    if (!organizationEnabled) return [];
    const searching = searchQuery.trim().length > 0;
    const validGroupIds = new Set(groups.map((group) => group.id));
    const sessionsByColor = new Map<
      DaemonSessionGroupColor,
      DaemonSessionSummary[]
    >();
    const sessionsByGroupId = new Map<string, DaemonSessionSummary[]>();
    for (const group of groups) {
      sessionsByGroupId.set(group.id, []);
    }
    const recentSessions: DaemonSessionSummary[] = [];
    for (const session of filteredSessions) {
      // Color takes precedence: the picker keeps color and group mutually
      // exclusive, but stay defensive if a store somehow carries both.
      if (session.color && SESSION_GROUP_COLORS.includes(session.color)) {
        const bucket = sessionsByColor.get(session.color) ?? [];
        bucket.push(session);
        sessionsByColor.set(session.color, bucket);
        continue;
      }
      const groupSessions =
        session.groupId && validGroupIds.has(session.groupId)
          ? sessionsByGroupId.get(session.groupId)
          : undefined;
      if (groupSessions) {
        groupSessions.push(session);
      } else {
        recentSessions.push(session);
      }
    }
    const sections: SessionSection[] = [];
    // Color buckets first, in palette order; only render non-empty ones so the
    // sidebar never shows six empty color headers.
    for (const color of SESSION_GROUP_COLORS) {
      const colorSessions = sessionsByColor.get(color);
      if (!colorSessions || colorSessions.length === 0) continue;
      sections.push({
        id: `color:${color}`,
        kind: 'color',
        label: t(`sidebar.groupColor.${color}`),
        countLabel: String(colorSessions.length),
        color,
        sessions: colorSessions,
      });
    }
    // Named groups next (kept visible even when empty, unless searching).
    for (const group of groups) {
      const groupSessions = sessionsByGroupId.get(group.id) ?? [];
      if (searching && groupSessions.length === 0) continue;
      sections.push({
        id: `group:${group.id}`,
        kind: 'group',
        label: group.name,
        countLabel: String(groupSessions.length),
        color: group.color,
        group,
        sessions: groupSessions,
      });
    }
    if (recentSessions.length > 0 && sections.length > 0) {
      sections.push({
        id: RECENT_SESSION_SECTION_ID,
        kind: 'recent',
        label: t('sidebar.groupUngrouped'),
        countLabel: String(recentSessions.length),
        sessions: recentSessions,
      });
    }
    return sections;
  }, [filteredSessions, groups, organizationEnabled, searchQuery, t]);

  useEffect(() => {
    const unseenIds = sessionSections
      .map((section) => section.id)
      .filter((id) => !knownSessionSectionIdsRef.current.has(id));
    if (unseenIds.length === 0) return;
    for (const id of unseenIds) knownSessionSectionIdsRef.current.add(id);
    setCollapsedSessionSectionIds((current) => {
      const next = new Set(current);
      for (const id of unseenIds) next.add(id);
      return next;
    });
  }, [sessionSections]);

  const toggleSessionSection = useCallback((sectionId: string) => {
    setCollapsedSessionSectionIds((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

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
      let collapsedByDrag = false;
      let teardown: (updateState: boolean) => void = () => undefined;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort; window listeners still handle drag.
      }
      function getRawWidth(clientX: number) {
        return startWidth + clientX - startX;
      }
      function restoreExpandedWidth() {
        const restoredWidth = clampSidebarWidth(startWidth);
        setSidebarWidth(restoredWidth);
        writeSidebarWidth(restoredWidth);
      }
      function collapseFromDrag() {
        if (collapsedByDrag) return;
        collapsedByDrag = true;
        restoreExpandedWidth();
        teardown(true);
        onCollapsedChange(true);
      }
      function handlePointerMove(moveEvent: PointerEvent) {
        const rawWidth = getRawWidth(moveEvent.clientX);
        if (rawWidth <= SIDEBAR_COLLAPSE_DRAG_WIDTH) {
          collapseFromDrag();
          return;
        }
        setSidebarWidth(clampSidebarVisualWidth(rawWidth));
      }
      teardown = function resizeTeardown(updateState: boolean) {
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
      function handlePointerUp(upEvent: PointerEvent) {
        const rawWidth = getRawWidth(upEvent.clientX);
        if (rawWidth <= SIDEBAR_COLLAPSE_DRAG_WIDTH) {
          collapseFromDrag();
          return;
        }
        const nextWidth = clampSidebarWidth(rawWidth);
        setSidebarWidth(nextWidth);
        writeSidebarWidth(nextWidth);
        teardown(true);
      }
      function handlePointerCancel() {
        teardown(true);
      }
      resizeTeardownRef.current = teardown;
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
      window.addEventListener('pointercancel', handlePointerCancel, {
        once: true,
      });
    },
    [collapsed, onCollapsedChange, sidebarWidth],
  );

  const deleteCandidateLabel = deleteCandidate
    ? getCompactSessionLabel(deleteCandidate)
    : '';
  const groupMenuSelectedColor =
    groupMenu?.session.color &&
    SESSION_GROUP_COLORS.includes(groupMenu.session.color)
      ? groupMenu.session.color
      : null;
  const groupMenuSelectedGroupId =
    !groupMenuSelectedColor &&
    groupMenu?.session.groupId &&
    groups.some((group) => group.id === groupMenu.session.groupId)
      ? groupMenu.session.groupId
      : null;
  const menuColorOptions =
    colorOptions.length > 0 ? colorOptions : SESSION_GROUP_COLORS;
  const groupMenuUngroupedSelected =
    groupMenuSelectedGroupId === null && groupMenuSelectedColor === null;
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

  const renderSessionRow = useCallback(
    (
      session: DaemonSessionSummary,
      options: {
        isArchived?: boolean;
        grouped?: boolean;
        // Suppress the per-session mutation actions (pin/group/archive/export/
        // more). Used for non-primary workspace rows: the daemon is bound to the
        // primary workspace, so those routes can't resolve another workspace's
        // session (they 404 or silently no-op). Such rows stay load-only.
        readOnly?: boolean;
      } = {},
    ) => {
      const { isArchived = false, grouped = false, readOnly = false } = options;
      const label = getSessionLabel(session);
      const stamp = session.updatedAt || session.createdAt;
      const time = stamp ? formatRelativeTime(stamp, t) : '';
      const busy = busySessionIds.has(session.sessionId);
      const completedUnread =
        session.sessionId !== currentSessionId &&
        completedUnreadIds.has(session.sessionId);
      const details = (
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
      if (isArchived) {
        return (
          <div
            key={session.sessionId}
            className={cx(
              styles.sessionRow,
              styles.archivedRow,
              busy && styles.busySession,
            )}
          >
            <span className={styles.sessionText}>{label}</span>
            <div className={styles.sessionMetaSlot}>
              <span className={styles.sessionTime}>{time}</span>
              <div
                className={styles.sessionActions}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={styles.sessionActionButton}
                      type="button"
                      aria-label={t('sidebar.moreActions')}
                      title={t('sidebar.moreActions')}
                    >
                      <EllipsisVerticalIcon />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="w-auto min-w-40"
                    onPointerDownOutside={() => {
                      sessionMenuPointerDismissRef.current = true;
                    }}
                    onCloseAutoFocus={(event) => {
                      if (!sessionMenuPointerDismissRef.current) return;
                      sessionMenuPointerDismissRef.current = false;
                      event.preventDefault();
                    }}
                  >
                    <DropdownMenuGroup>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <InfoIcon />
                          {t('sidebar.details')}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="min-w-64 p-3">
                          {details}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuItem
                        onSelect={() => handleUnarchive(session)}
                      >
                        <ArchiveRestoreIcon />
                        {t('sidebar.unarchive')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => handleDeleteSession(session)}
                      >
                        <Trash2Icon />
                        {t('sidebar.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        );
      }

      const isCurrent = session.sessionId === currentSessionId;
      const isEditing = editingSessionId === session.sessionId;
      const exporting = exportingSessionIds.has(session.sessionId);
      return (
        <div
          key={session.sessionId}
          className={cx(
            styles.sessionRow,
            grouped && styles.groupedSessionRow,
            isCurrent && styles.currentSession,
            session.isPinned && styles.pinnedSession,
            session.hasActivePrompt && styles.runningSession,
            busy && styles.busySession,
          )}
          role="button"
          tabIndex={0}
          aria-current={isCurrent ? 'page' : undefined}
          onClick={() =>
            handleLoadSession(session.sessionId, session.workspaceCwd)
          }
          onDoubleClick={() => {
            if (!readOnly && isCurrent && !collapsed) startRename(session);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleLoadSession(session.sessionId, session.workspaceCwd);
            }
          }}
        >
          {!collapsed && (
            <>
              <span className={styles.sessionStatusSlot}>
                {completedUnread ? (
                  <span
                    className={styles.sessionStatusDot}
                    aria-hidden="true"
                  />
                ) : session.isPinned ? (
                  readOnly ? (
                    <span
                      className={styles.sessionTitlePin}
                      aria-label={t('sidebar.pin')}
                    >
                      <PinIcon />
                    </span>
                  ) : (
                    <button
                      className={styles.sessionTitlePin}
                      type="button"
                      disabled={busy}
                      title={t('sidebar.unpin')}
                      aria-label={t('sidebar.unpin')}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleTogglePin(session);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <PinIcon />
                    </button>
                  )
                ) : null}
              </span>
              {isEditing && !readOnly ? (
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
                    {!readOnly && (
                      <div
                        className={styles.sessionActions}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {organizationEnabled && (
                          <button
                            className={cx(
                              styles.sessionActionButton,
                              session.isPinned &&
                                styles.activeSessionActionButton,
                            )}
                            type="button"
                            disabled={busy}
                            aria-label={
                              session.isPinned
                                ? t('sidebar.unpin')
                                : t('sidebar.pin')
                            }
                            title={
                              session.isPinned
                                ? t('sidebar.unpin')
                                : t('sidebar.pin')
                            }
                            onClick={() => handleTogglePin(session)}
                          >
                            <PinIcon />
                          </button>
                        )}
                        <button
                          className={styles.sessionActionButton}
                          type="button"
                          disabled={busy || isCurrent}
                          aria-label={t('sidebar.archive')}
                          title={
                            isCurrent
                              ? t('sidebar.archiveCurrentDisabled')
                              : t('sidebar.archive')
                          }
                          onClick={() => handleArchive(session)}
                        >
                          <ArchiveIcon />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className={styles.sessionActionButton}
                              type="button"
                              aria-label={t('sidebar.moreActions')}
                              title={t('sidebar.moreActions')}
                            >
                              <EllipsisVerticalIcon />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="w-auto min-w-40"
                            onPointerDownOutside={() => {
                              sessionMenuPointerDismissRef.current = true;
                            }}
                            onCloseAutoFocus={(event) => {
                              if (!sessionMenuPointerDismissRef.current) return;
                              sessionMenuPointerDismissRef.current = false;
                              event.preventDefault();
                            }}
                          >
                            <DropdownMenuGroup>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger>
                                  <InfoIcon />
                                  {t('sidebar.details')}
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="min-w-64 p-3">
                                  {details}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuItem
                                disabled={!isCurrent}
                                title={
                                  !isCurrent
                                    ? t('sidebar.renameCurrentOnly')
                                    : undefined
                                }
                                onSelect={() => handleRenameFromMenu(session)}
                              >
                                <PencilIcon />
                                {t('sidebar.rename')}
                              </DropdownMenuItem>
                              {organizationEnabled && (
                                <DropdownMenuItem
                                  disabled={busy}
                                  onSelect={(event) =>
                                    openGroupMenuFromAnchor(
                                      event.currentTarget as HTMLElement,
                                      session,
                                    )
                                  }
                                >
                                  <FolderInputIcon />
                                  {t('sidebar.sessionGroup')}
                                </DropdownMenuItem>
                              )}
                              {canExportSessions && (
                                <DropdownMenuItem
                                  disabled={exporting}
                                  onSelect={() => handleExportSession(session)}
                                >
                                  <DownloadIcon />
                                  {t('sidebar.export')}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                variant="destructive"
                                disabled={isCurrent}
                                title={
                                  isCurrent
                                    ? t('sidebar.currentDeleteDisabled')
                                    : undefined
                                }
                                onSelect={() => handleDeleteSession(session)}
                              >
                                <Trash2Icon />
                                {t('sidebar.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuGroup>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      );
    },
    [
      busySessionIds,
      canExportSessions,
      cancelRename,
      collapsed,
      completedUnreadIds,
      currentSessionId,
      editingName,
      editingSessionId,
      exportingSessionIds,
      handleArchive,
      handleDeleteSession,
      handleExportSession,
      handleLoadSession,
      handleRenameFromMenu,
      handleTogglePin,
      handleUnarchive,
      openGroupMenuFromAnchor,
      organizationEnabled,
      saveRename,
      startRename,
      t,
    ],
  );

  const body = useMemo(() => {
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
    if (
      filteredSessions.length === 0 &&
      (searchQuery.trim() ||
        !organizationEnabled ||
        sessionSections.length === 0)
    ) {
      return <div className={styles.notice}>{t('sidebar.searchEmpty')}</div>;
    }
    if (!organizationEnabled) {
      return filteredSessions.map((session) => renderSessionRow(session));
    }
    if (sessionSections.length === 0) {
      return filteredSessions.map((session) => renderSessionRow(session));
    }

    return sessionSections.map((section) => {
      const expanded = !collapsedSessionSectionIds.has(section.id);
      const group = section.group;
      return (
        <section
          key={section.id}
          className={styles.sessionGroupSection}
          aria-label={section.label}
        >
          <div className={styles.sessionGroupHeaderRow}>
            <button
              type="button"
              className={styles.sessionGroupHeader}
              aria-expanded={expanded}
              onClick={() => toggleSessionSection(section.id)}
            >
              {section.color || section.kind === 'recent' ? (
                <span
                  className={cx(
                    styles.sessionGroupDot,
                    section.color
                      ? getGroupColorClass(section.color)
                      : styles.sessionGroupDotMuted,
                  )}
                  aria-hidden="true"
                />
              ) : null}
              <span className={styles.sessionGroupTitle}>{section.label}</span>
              {section.countLabel ? (
                <span className={styles.sessionGroupCount}>
                  · {section.countLabel}
                </span>
              ) : null}
              <span className={styles.sessionGroupChevron} aria-hidden="true">
                {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </span>
            </button>
            <div className={styles.sessionGroupHeaderActions}>
              {section.kind === 'group' && group ? (
                <>
                  <button
                    className={styles.sessionGroupActionButton}
                    type="button"
                    title={t('sidebar.groupRename')}
                    aria-label={t('sidebar.groupRename')}
                    disabled={groupBusy}
                    onClick={() => handleRenameGroup(group)}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className={styles.sessionGroupActionButton}
                    type="button"
                    title={t('sidebar.groupDelete')}
                    aria-label={t('sidebar.groupDelete')}
                    disabled={groupBusy}
                    onClick={() => handleDeleteGroup(group)}
                  >
                    <Trash2Icon />
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {expanded && (
            <div className={styles.sessionGroupList}>
              {section.sessions.map((session) => renderSessionRow(session))}
            </div>
          )}
        </section>
      );
    });
  }, [
    collapsedSessionSectionIds,
    error,
    filteredSessions,
    groupBusy,
    handleDeleteGroup,
    handleRenameGroup,
    loading,
    organizationEnabled,
    reload,
    renderSessionRow,
    searchQuery,
    sessionSections,
    sessions.length,
    t,
    toggleSessionSection,
  ]);

  const archivedSection = useMemo(() => {
    if (collapsed || searchQuery.trim()) return null;

    const header = (
      <button
        type="button"
        className={styles.archivedHeader}
        aria-expanded={archivedExpanded}
        onClick={() => setArchivedExpanded((expanded) => !expanded)}
      >
        <span className={styles.archivedTitle} style={{ flex: '0 1 auto' }}>
          {t('sidebar.archivedTitle')}
        </span>
        <span className={styles.archivedChevron} aria-hidden="true">
          {archivedExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        </span>
        {archivedExpanded && archivedSessions.length > 0 && (
          <span className={styles.archivedCount}>
            {archivedSessions.length}
          </span>
        )}
      </button>
    );

    if (!archivedExpanded) {
      return <div className={styles.archivedSection}>{header}</div>;
    }

    let content: ReactNode;
    if (archivedLoading && archivedSessions.length === 0) {
      content = (
        <div className={styles.notice}>{t('sidebar.loadingSessions')}</div>
      );
    } else if (archivedError && archivedSessions.length === 0) {
      content = (
        <button
          className={styles.retry}
          type="button"
          onClick={() => reloadArchived()}
        >
          {t('sidebar.loadFailed')}
        </button>
      );
    } else if (archivedSessions.length === 0) {
      content = (
        <div className={styles.notice}>{t('sidebar.archivedEmpty')}</div>
      );
    } else {
      content = archivedSessions.map((session) =>
        renderSessionRow(session, { isArchived: true }),
      );
    }

    return (
      <div className={styles.archivedSection}>
        {header}
        <div className={styles.archivedList}>{content}</div>
      </div>
    );
  }, [
    archivedError,
    archivedExpanded,
    archivedLoading,
    archivedSessions,
    collapsed,
    reloadArchived,
    renderSessionRow,
    searchQuery,
    t,
  ]);

  return (
    <>
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
        {groupMenu && (
          <div
            ref={groupMenuRef}
            className={styles.groupMenu}
            role="menu"
            aria-label={t('sidebar.sessionGroup')}
            style={{ top: groupMenu.top, left: groupMenu.left }}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleGroupMenuKeyDown}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className={cx(
                styles.groupMenuItem,
                groupMenuUngroupedSelected && styles.groupMenuItemActive,
              )}
              type="button"
              role="menuitemradio"
              aria-checked={groupMenuUngroupedSelected}
              onClick={() => assignSessionGroup(groupMenu.session, null)}
            >
              <span className={styles.groupMenuEmptyDot} />
              <span className={styles.groupMenuName}>
                {t('sidebar.groupUngrouped')}
              </span>
              {groupMenuUngroupedSelected && (
                <span className={styles.groupMenuCheck}>✓</span>
              )}
            </button>
            {menuColorOptions.map((color) => {
              const selected = groupMenuSelectedColor === color;
              return (
                <button
                  key={`color:${color}`}
                  className={cx(
                    styles.groupMenuItem,
                    selected && styles.groupMenuItemActive,
                  )}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => assignSessionColor(groupMenu.session, color)}
                >
                  <span
                    className={cx(
                      styles.groupMenuDot,
                      getGroupColorClass(color),
                    )}
                  />
                  <span className={styles.groupMenuName}>
                    {t(`sidebar.groupColor.${color}`)}
                  </span>
                  {selected && <span className={styles.groupMenuCheck}>✓</span>}
                </button>
              );
            })}
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
                  onClick={() =>
                    assignSessionGroup(groupMenu.session, group.id)
                  }
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
              className="flex flex-col gap-6"
              onSubmit={(event) => {
                event.preventDefault();
                saveGroupEditor();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="session-group-name">
                    {t('sidebar.groupNamePrompt')}
                  </FieldLabel>
                  <Input
                    id="session-group-name"
                    value={groupName}
                    autoFocus
                    maxLength={64}
                    onChange={(event) => setGroupName(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="session-group-color">
                    {t('sidebar.groupColor')}
                  </FieldLabel>
                  <Select
                    value={groupColor}
                    onValueChange={(value) =>
                      setGroupColor(value as DaemonSessionGroupColor)
                    }
                  >
                    <SelectTrigger id="session-group-color" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {groupColorChoices.map((color) => (
                          <SelectItem key={color} value={color}>
                            {t(`sidebar.groupColor.${color}`)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={groupBusy}
                  onClick={closeGroupEditor}
                >
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={!canSaveGroup}>
                  {t('common.save')}
                </Button>
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
        <div className={styles.topRow}>
          <span className={styles.brandLogo} aria-hidden="true">
            <IconQwenLogo />
          </span>
          {!collapsed && <span className={styles.brandName}>Qwen Code</span>}
        </div>
        <div className={styles.primaryNav}>
          <button
            className={styles.newChatButton}
            type="button"
            title={t('sidebar.newTask')}
            aria-label={t('sidebar.newTask')}
            disabled={newSessionDisabled}
            onClick={() => handleNewSession()}
          >
            <span className={styles.navIcon}>
              <SquarePenIcon size={16} strokeWidth={1.2} />
            </span>
            {!collapsed && <span>{t('sidebar.newTask')}</span>}
          </button>
          <button
            className={styles.pluginButton}
            type="button"
            title={t('sidebar.scheduledTasks')}
            aria-label={t('sidebar.scheduledTasks')}
            onClick={onOpenScheduledTasks}
          >
            <span className={styles.navIcon}>
              <CalendarClockIcon size={16} strokeWidth={1.2} />
            </span>
            {!collapsed && <span>{t('sidebar.scheduledTasks')}</span>}
          </button>
        </div>
        {!collapsed && (
          <div className={styles.projectsHeader}>
            <button
              className={styles.projectsHeaderToggle}
              type="button"
              aria-expanded={projectsExpanded}
              onClick={() => setProjectsExpanded((expanded) => !expanded)}
            >
              <span>{t('sidebar.project')}</span>
              <IconChevron expanded={projectsExpanded} />
            </button>
            <div className={styles.projectsHeaderActions}>
              <button
                className={styles.projectsHeaderAction}
                type="button"
                title={t('sidebar.search')}
                aria-label={t('sidebar.search')}
                onClick={() => {
                  setSearchOpen((open) => {
                    if (open) setSearchQuery('');
                    return !open;
                  });
                  setProjectsExpanded(true);
                }}
              >
                <SearchIcon />
              </button>
              <button
                className={styles.projectsHeaderAction}
                type="button"
                title={t('sidebar.addWorkspace')}
                aria-label={t('sidebar.addWorkspace')}
                onClick={() => {
                  setShowAddWorkspaceDialog(true);
                }}
              >
                <PlusIcon />
              </button>
            </div>
          </div>
        )}
        {searchOpen && !collapsed && (
          <div className={styles.projectSearch}>
            <SearchIcon aria-hidden="true" />
            <Input
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
          </div>
        )}
        <div className={styles.body}>
          <div className={styles.sessionList}>
            {(collapsed || projectsExpanded) && (
              <>
                {!collapsed && (
                  <div className={styles.workspacePicker}>
                    <div className={styles.workspaceList}>
                      {displayedWorkspaces.map((ws) => (
                        <Fragment key={ws.id}>
                          <WorkspaceSection
                            workspace={ws}
                            client={workspace.client}
                            isActive={
                              currentSessionId
                                ? connection.workspaceCwd === ws.cwd
                                : ws.primary
                                  ? selectedWorkspaceCwd === undefined
                                  : selectedWorkspaceCwd === ws.cwd
                            }
                            reloadToken={workspaceSessionsReloadToken}
                            primaryLabel={
                              displayedWorkspaces.length > 1
                                ? t('sidebar.workspacePrimary')
                                : ''
                            }
                            untrustedLabel={t('sidebar.workspaceUntrusted')}
                            readOnlyLabel={t('sidebar.workspaceReadOnly')}
                            trustToOpenLabel={t('sidebar.workspaceTrustToOpen')}
                            noSessionsLabel={t('sidebar.noSessions')}
                            loadErrorLabel={t('sidebar.loadFailed')}
                            formatTime={(iso) => formatRelativeTime(iso, t)}
                            searchQuery={searchQuery}
                            expanded={ws.primary ? projectExpanded : undefined}
                            autoExpandKey={
                              autoExpandWorkspace?.id === ws.id
                                ? autoExpandWorkspace?.key
                                : undefined
                            }
                            onExpandedChange={
                              ws.primary ? setProjectExpanded : undefined
                            }
                            content={ws.primary ? null : undefined}
                            renderSession={(session) =>
                              renderSessionRow(session, {
                                readOnly: !ws.primary,
                              })
                            }
                            headerActions={(visible) => (
                              <div
                                className={styles.workspaceHeaderActions}
                                style={{
                                  visibility: visible ? 'visible' : 'hidden',
                                }}
                              >
                                {ws.primary && (
                                  <button
                                    className={styles.workspaceHeaderAction}
                                    type="button"
                                    aria-label={t('sidebar.groupCreate')}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      handleCreateGroup();
                                    }}
                                  >
                                    <PlusIcon size={16} strokeWidth={1.2} />
                                  </button>
                                )}
                                <button
                                  className={styles.workspaceHeaderAction}
                                  type="button"
                                  title={t('sidebar.newTask')}
                                  aria-label={t('sidebar.newTask')}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    handleNewSession(
                                      ws.primary ? undefined : ws.cwd,
                                    );
                                  }}
                                >
                                  <SquarePenIcon size={16} strokeWidth={1.2} />
                                </button>
                              </div>
                            )}
                          />
                          {ws.primary && (projectExpanded || searchQuery.trim())
                            ? body
                            : null}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            {archivedSection}
          </div>
        </div>

        <div
          className={cx(
            styles.footer,
            footerCompact && styles.footerCompact,
            footerTight && styles.footerTight,
          )}
        >
          <div className={styles.footerPrimary}>
            <button
              className={styles.footerButton}
              type="button"
              title={t('sidebar.settings')}
              aria-label={t('sidebar.settings')}
              onClick={onOpenSettings}
            >
              <span className={`${styles.navIcon} ${styles.settingsIcon}`}>
                <SettingsIcon size={16} strokeWidth={1.2} />
              </span>
              {!collapsed && !footerCompact && (
                <span className={styles.footerButtonLabel}>
                  {t('sidebar.settings')}
                </span>
              )}
            </button>
            {!collapsed && !footerTight && versionLabel && (
              <span
                className={styles.version}
                title={`Qwen Code ${versionLabel}`}
              >
                {versionLabel}
              </span>
            )}
          </div>
          <div className={styles.footerActions}>
            <button
              className={styles.collapseButton}
              type="button"
              title={
                theme === WebShellThemeId.Dark
                  ? t('sidebar.themeLight')
                  : t('sidebar.themeDark')
              }
              aria-label={
                theme === WebShellThemeId.Dark
                  ? t('sidebar.themeLight')
                  : t('sidebar.themeDark')
              }
              onClick={() =>
                onThemeChange(
                  theme === WebShellThemeId.Dark
                    ? WebShellThemeId.Light
                    : WebShellThemeId.Dark,
                )
              }
            >
              {theme === WebShellThemeId.Dark ? (
                <SunIcon size={16} strokeWidth={1.2} />
              ) : (
                <MoonIcon size={16} strokeWidth={1.2} />
              )}
            </button>
            {canOpenSessionsOverview && (
              <button
                className={styles.collapseButton}
                type="button"
                title={t('sidebar.sessionsOverview')}
                aria-label={t('sidebar.sessionsOverview')}
                onClick={onOpenSessions}
              >
                <LayoutGridIcon size={16} strokeWidth={1.2} />
              </button>
            )}
            {canOpenSplitView && (
              <button
                className={styles.collapseButton}
                type="button"
                title={t('sidebar.splitView')}
                aria-label={t('sidebar.splitView')}
                onClick={onOpenSplitView}
              >
                <Columns2Icon size={16} strokeWidth={1.2} />
              </button>
            )}
            <button
              className={styles.collapseButton}
              type="button"
              title={t('sidebar.daemonStatus')}
              aria-label={t('sidebar.daemonStatus')}
              onClick={onOpenDaemonStatus}
            >
              <ActivityIcon size={16} strokeWidth={1.2} />
            </button>
            {!mobileOpen && (
              <button
                className={styles.collapseButton}
                type="button"
                title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                aria-label={
                  collapsed ? t('sidebar.expand') : t('sidebar.collapse')
                }
                onClick={() => onCollapsedChange(!collapsed)}
              >
                {collapsed ? (
                  <PanelLeftOpenIcon size={16} strokeWidth={1.2} />
                ) : (
                  <PanelLeftCloseIcon size={16} strokeWidth={1.2} />
                )}
              </button>
            )}
          </div>
        </div>
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={handleResizePointerDown}
        />
      </aside>
      {showAddWorkspaceDialog && (
        <AddWorkspaceDialog
          onClose={() => setShowAddWorkspaceDialog(false)}
          onAdd={handleAddWorkspace}
        />
      )}
    </>
  );
}

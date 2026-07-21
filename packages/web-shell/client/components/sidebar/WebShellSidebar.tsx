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
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type {
  DaemonSessionGroup,
  DaemonSessionGroupColor,
  DaemonSessionGroupHexColor,
  DaemonSessionGroupPresetColor,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceRemovalActivity,
} from '@qwen-code/sdk/daemon';
import {
  ActivityIcon,
  BlocksIcon,
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
  GitForkIcon,
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
  TargetIcon,
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
import { SessionGroupSection } from './SessionGroupSection';
import {
  isPrimaryCollapsedSectionId,
  readCollapsedSessionSectionIds,
  replaceOwnedCollapsedSessionSectionIds,
} from './collapsedSessionSections';
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
const CUSTOM_GROUP_COLOR_OPTION = '__custom__';
const DEFAULT_CUSTOM_GROUP_COLOR: DaemonSessionGroupHexColor = '#416ef5';

function getSessionIdentity(
  sessionId: string,
  workspaceCwd: string | undefined,
): string {
  return `${workspaceCwd ?? ''}\0${sessionId}`;
}

export type WebShellSidebarFooterItem =
  | 'settings'
  | 'version'
  | 'theme'
  | 'sessionsOverview'
  | 'splitView'
  | 'daemonStatus'
  | 'collapse';

export interface WebShellSidebarBranding {
  /** Replace the complete top branding row. */
  render?: () => ReactNode;
  /** Hide the branding row in the compact drawer. Defaults to true. */
  hideWhenCompact?: boolean;
}

export interface WebShellSidebarLockedWorkspace {
  /** Replace the locked workspace row content while preserving its built-in behavior. */
  render?: (
    workspace: DaemonWorkspaceCapability,
    state: { expanded: boolean },
  ) => ReactNode;
}

export type WebShellSidebarPrimaryNavItem =
  | 'newTask'
  | 'plugins'
  | 'scheduledTasks'
  | 'goals';

export interface WebShellSidebarPrimaryNavOptions {
  /** Built-in primary nav entries to show. Defaults to all. */
  items?: readonly WebShellSidebarPrimaryNavItem[];
  /** Additional custom content rendered after the built-in nav buttons. */
  render?: () => ReactNode;
}

export interface WebShellSidebarFooterOptions {
  /** Built-in footer entries to expose. Entries use the canonical footer order. */
  items?: readonly WebShellSidebarFooterItem[];
  /** Additional custom content rendered before the built-in footer items (left side). */
  render?: () => ReactNode;
}

const DEFAULT_FOOTER_ITEMS: readonly WebShellSidebarFooterItem[] = [
  'settings',
  'version',
  'theme',
  'sessionsOverview',
  'splitView',
  'daemonStatus',
  'collapse',
];

const DEFAULT_PRIMARY_NAV_ITEMS: readonly WebShellSidebarPrimaryNavItem[] = [
  'newTask',
  'plugins',
  'scheduledTasks',
  'goals',
];

export type WebShellSidebarSessionActionItem =
  | 'details'
  | 'rename'
  | 'group'
  | 'export'
  | 'delete'
  | 'pin'
  | 'archive';

/** Subset of action items that have working inline (hover-button) handlers. */
export type WebShellSidebarSessionInlineActionItem =
  | 'pin'
  | 'archive'
  | 'rename'
  | 'export'
  | 'delete';

export interface WebShellSidebarSessionActionsOptions {
  /** Session action items to show. Defaults to all. */
  items?: readonly WebShellSidebarSessionActionItem[];
  /**
   * Which items appear as inline buttons (on hover). Defaults to ['pin', 'archive'].
   * Only items that also pass their built-in visibility condition are rendered.
   * Only items with working inline handlers are accepted (details/group are dropdown-only).
   */
  inlineItems?: readonly WebShellSidebarSessionInlineActionItem[];
}

const DEFAULT_SESSION_ACTION_ITEMS: readonly WebShellSidebarSessionActionItem[] =
  ['details', 'rename', 'group', 'export', 'delete', 'pin', 'archive'];

const DEFAULT_INLINE_ACTION_ITEMS: readonly WebShellSidebarSessionInlineActionItem[] =
  ['pin', 'archive'];

/**
 * Palette order for the quick color-grouping buckets. Mirrors core's
 * `GROUP_COLOR_OPTIONS`; kept as a local constant so the client never imports
 * from core. Used both to order the color sections and as a fallback when the
 * daemon's color catalog has not loaded yet.
 */
const SESSION_GROUP_COLORS: DaemonSessionGroupPresetColor[] = [
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
  workspaceCwd?: string;
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
  onOpenPlugins: () => void;
  onOpenDaemonStatus: () => void;
  onOpenScheduledTasks: () => void;
  onOpenGoals: () => void;
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
  onNewSession: (
    workspaceCwd?: string,
    opts?: { worktree?: { slug?: string } },
  ) => Promise<boolean> | boolean;
  onLoadSession: (
    sessionId: string,
    workspaceCwd?: string,
  ) => Promise<void> | void;
  onSelectCurrentSession?: () => void;
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
  /**
   * Open the working-tree Changes dialog for a workspace. Forwarded to each
   * trusted workspace's folder header, where a live git chip fires it on click.
   */
  onOpenGitDiff?: (workspaceCwd: string) => void;
  workspaces?: DaemonWorkspaceCapability[];
  lockedWorkspaceCwd?: string;
  lockedWorkspace?: WebShellSidebarLockedWorkspace;
  branding?: false | WebShellSidebarBranding;
  primaryNav?: WebShellSidebarPrimaryNavOptions;
  /** Whether to hide the "Projects" header row (with search and add workspace). Defaults to false (shown). */
  hideProjectHeader?: boolean;
  /** Customize which action buttons appear on session rows. */
  sessionActions?: WebShellSidebarSessionActionsOptions;
  footer?: false | WebShellSidebarFooterOptions;
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
  colorOptions: DaemonSessionGroupPresetColor[],
): DaemonSessionGroupPresetColor {
  return colorOptions[0] ?? 'blue';
}

function normalizeHexColorInput(
  value: string,
): DaemonSessionGroupHexColor | undefined {
  const normalized = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return normalized.toLowerCase() as DaemonSessionGroupHexColor;
  }
  return undefined;
}

function normalizeGroupColorInput(
  value: string,
  presets: readonly DaemonSessionGroupPresetColor[],
): DaemonSessionGroupColor | undefined {
  const normalized = value.trim();
  if (presets.includes(normalized as DaemonSessionGroupPresetColor)) {
    return normalized as DaemonSessionGroupPresetColor;
  }
  return normalizeHexColorInput(normalized);
}

function getGroupColorClass(
  color: DaemonSessionGroupColor,
): string | undefined {
  if (color.startsWith('#')) return styles.groupColorCustom;
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
  return undefined;
}

function getGroupColorStyle(
  color: DaemonSessionGroupColor,
): CSSProperties | undefined {
  return color.startsWith('#') ? { backgroundColor: color } : undefined;
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
  onOpenPlugins,
  onOpenDaemonStatus,
  onOpenScheduledTasks,
  onOpenGoals,
  onOpenSessions,
  canOpenSessionsOverview,
  onOpenSplitView,
  canOpenSplitView,
  onNewSession,
  onLoadSession,
  onSelectCurrentSession,
  onError,
  theme,
  onThemeChange,
  mobileOpen,
  sessionListReloadToken,
  selectedWorkspaceCwd,
  onSelectWorkspace,
  onOpenGitDiff,
  workspaces: providedWorkspaces,
  lockedWorkspaceCwd,
  lockedWorkspace: lockedWorkspaceOptions,
  branding,
  primaryNav: primaryNavOptions,
  hideProjectHeader,
  sessionActions: sessionActionsOptions,
  footer,
}: WebShellSidebarProps) {
  const { t } = useI18n();
  const connection = useConnection();
  const actions = useActions();
  const workspaceActions = useWorkspaceActions();
  const workspace = useWorkspace();
  const footerItems = useMemo(
    () =>
      new Set(footer === false ? [] : (footer?.items ?? DEFAULT_FOOTER_ITEMS)),
    [footer],
  );
  const primaryNavItems = useMemo(
    () => new Set(primaryNavOptions?.items ?? DEFAULT_PRIMARY_NAV_ITEMS),
    [primaryNavOptions?.items],
  );
  const sessionActionItems = useMemo(
    () => new Set(sessionActionsOptions?.items ?? DEFAULT_SESSION_ACTION_ITEMS),
    [sessionActionsOptions?.items],
  );
  const inlineActionItems = useMemo(
    () =>
      new Set(
        sessionActionsOptions?.inlineItems ?? DEFAULT_INLINE_ACTION_ITEMS,
      ),
    [sessionActionsOptions?.inlineItems],
  );
  const shouldRenderBrand =
    branding !== false && !(mobileOpen && (branding?.hideWhenCompact ?? true));
  const organizationEnabled = Boolean(
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE),
  );
  const sessionArchiveEnabled = Boolean(
    connection.capabilities?.features?.includes('session_archive'),
  );
  const workspaceQualifiedRestCoreEnabled = Boolean(
    connection.capabilities?.features?.includes(
      'workspace_qualified_rest_core',
    ),
  );
  // Phase 4: registered workspaces on a multi-workspace daemon (absent or a
  // single entry otherwise). Drives the new-session workspace picker.
  const workspaces = useMemo(
    () => providedWorkspaces ?? workspace.capabilities?.workspaces ?? [],
    [providedWorkspaces, workspace.capabilities?.workspaces],
  );
  const primaryWorkspaceCwd =
    workspaces.find((entry) => entry.primary)?.cwd ??
    workspace.capabilities?.workspaceCwd ??
    connection.workspaceCwd;
  const lockedWorkspace = lockedWorkspaceCwd
    ? workspaces.find((entry) => entry.cwd === lockedWorkspaceCwd)
    : undefined;
  const includePrimaryWorkspaceSessions =
    !lockedWorkspaceCwd || lockedWorkspace?.primary === true;
  const {
    sessions,
    loading,
    error,
    data: sessionsPage,
    reload,
    deleteSession,
    exportSession,
    archiveSession,
  } = useSessions({
    autoLoad: true,
    enabled: includePrimaryWorkspaceSessions,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  // useDaemonResource starts with loading=false before autoLoad runs, so
  // !loading is not “settled”. Treat the first data as the ready signal (empty
  // lists are still defined data) so the initial-catalog latch waits. Errors
  // must NOT settle it: a latch consumed against a failed request would treat
  // every section from the eventual successful reload as brand-new,
  // auto-collapsing and persisting over the user's restored expansions.
  const sessionsCatalogReady =
    !organizationEnabled ||
    !includePrimaryWorkspaceSessions ||
    sessionsPage !== undefined;
  const { sessions: primaryPinnedSessions, reload: reloadPinnedSessions } =
    useSessions({
      autoLoad: organizationEnabled,
      enabled: organizationEnabled && includePrimaryWorkspaceSessions,
      pageSize: SESSION_LIST_PAGE_SIZE,
      archiveState: 'active',
      view: 'organized',
      group: 'pinned',
    });
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [secondaryPinnedSessions, setSecondaryPinnedSessions] = useState<
    DaemonSessionSummary[]
  >([]);
  const {
    sessions: archivedSessions,
    loading: archivedLoading,
    error: archivedError,
    reload: reloadArchived,
    deleteSession: deleteArchivedSession,
    unarchiveSession,
  } = useSessions({
    autoLoad: true,
    enabled:
      sessionArchiveEnabled &&
      archivedExpanded &&
      includePrimaryWorkspaceSessions,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'archived',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const [secondaryArchivedSessions, setSecondaryArchivedSessions] = useState<
    DaemonSessionSummary[]
  >([]);
  const [secondaryArchivedLoading, setSecondaryArchivedLoading] =
    useState(false);
  const [secondaryArchivedError, setSecondaryArchivedError] = useState(false);
  const [secondaryArchivedReloadToken, setSecondaryArchivedReloadToken] =
    useState(0);
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [menuGroups, setMenuGroups] = useState<DaemonSessionGroup[]>([]);
  const [colorOptions, setColorOptions] = useState<
    DaemonSessionGroupPresetColor[]
  >([]);
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
  const [lastValidCustomGroupColor, setLastValidCustomGroupColor] =
    useState<DaemonSessionGroupHexColor>(DEFAULT_CUSTOM_GROUP_COLOR);
  const [deleteGroupCandidate, setDeleteGroupCandidate] = useState<{
    group: DaemonSessionGroup;
    workspaceCwd?: string;
  } | null>(null);
  const [collapsedSessionSectionIds, setCollapsedSessionSectionIds] = useState<
    Set<string>
  >(
    () =>
      new Set(
        Array.from(readCollapsedSessionSectionIds()).filter(
          isPrimaryCollapsedSectionId,
        ),
      ),
  );
  const knownSessionSectionIdsRef = useRef<Set<string>>(new Set());
  // Dedicated first-sync latch. Cleared only after both groups catalog and
  // sessions list have settled (including empty responses). Do not infer this
  // from knownSessionSectionIdsRef.size — seeding that set early would make the
  // first real sync look mid-session and auto-collapse restored expansions.
  const awaitingInitialSessionCatalogRef = useRef(true);
  const [groupsCatalogReady, setGroupsCatalogReady] =
    useState(!organizationEnabled);
  // organizationEnabled can flip true mid-session (capabilities can land after
  // the flat sessions request settles). Close the gate during that same render:
  // deferring to the reload effect would let the auto-collapse effect consume
  // the first-sync latch against the stale pre-organized catalog first.
  const [prevOrganizationEnabled, setPrevOrganizationEnabled] =
    useState(organizationEnabled);
  if (prevOrganizationEnabled !== organizationEnabled) {
    setPrevOrganizationEnabled(organizationEnabled);
    setGroupsCatalogReady(!organizationEnabled);
  }
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [projectExpanded, setProjectExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] = useState(false);
  const [workspaceRemovalCandidate, setWorkspaceRemovalCandidate] =
    useState<DaemonWorkspaceCapability | null>(null);
  const [workspaceRemovalActivity, setWorkspaceRemovalActivity] =
    useState<DaemonWorkspaceRemovalActivity | null>(null);
  const [workspaceRemovalSubmitting, setWorkspaceRemovalSubmitting] =
    useState(false);
  const workspaceRemovalMountedRef = useRef(false);
  const workspaceRemovalDismissedRef = useRef(false);
  const [
    workspaceRemovalRemoteInProgress,
    setWorkspaceRemovalRemoteInProgress,
  ] = useState(false);
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

  useEffect(() => {
    workspaceRemovalMountedRef.current = true;
    return () => {
      workspaceRemovalMountedRef.current = false;
      workspaceRemovalDismissedRef.current = true;
    };
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
  const workspaceRemovalEnabled = Boolean(
    connection.capabilities?.features?.includes('workspace_runtime_removal'),
  );
  const canExportSessions =
    connection.capabilities?.features?.includes('session_export') ?? false;
  const canExportArchivedSessions =
    connection.capabilities?.features?.includes(
      'workspace_archived_session_export',
    ) ?? false;
  const currentSessionIdentity = currentSessionId
    ? getSessionIdentity(currentSessionId, connection.workspaceCwd)
    : null;
  const projectName =
    getWorkspaceName(connection.workspaceCwd) || t('sidebar.projectFallback');
  const displayedWorkspaces = useMemo<DaemonWorkspaceCapability[]>(() => {
    const availableWorkspaces =
      workspaces.length > 0
        ? workspaces
        : [
            {
              id: 'primary',
              cwd: connection.workspaceCwd || projectName,
              primary: true,
              trusted: true,
            },
          ];
    return lockedWorkspaceCwd
      ? availableWorkspaces.filter((entry) => entry.cwd === lockedWorkspaceCwd)
      : availableWorkspaces;
  }, [connection.workspaceCwd, lockedWorkspaceCwd, projectName, workspaces]);
  const pinnedSessions = useMemo(() => {
    const byId = new Map<string, DaemonSessionSummary>();
    for (const session of [
      ...(includePrimaryWorkspaceSessions ? primaryPinnedSessions : []),
      ...secondaryPinnedSessions,
    ]) {
      byId.set(
        getSessionIdentity(
          session.sessionId,
          session.workspaceCwd || primaryWorkspaceCwd,
        ),
        session,
      );
    }
    return [...byId.values()];
  }, [
    includePrimaryWorkspaceSessions,
    primaryWorkspaceCwd,
    primaryPinnedSessions,
    secondaryPinnedSessions,
  ]);
  const getSessionWorkspaceActions = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionWorkspace = displayedWorkspaces.find(
        (entry) => entry.cwd === session.workspaceCwd,
      );
      return !sessionWorkspace || sessionWorkspace.primary
        ? workspaceActions
        : workspace.client.workspaceByCwd(sessionWorkspace.cwd);
    },
    [displayedWorkspaces, workspace.client, workspaceActions],
  );
  const isPrimaryWorkspaceCwd = useCallback(
    (workspaceCwd: string | undefined) =>
      !workspaceCwd ||
      displayedWorkspaces.find((entry) => entry.cwd === workspaceCwd)
        ?.primary !== false,
    [displayedWorkspaces],
  );
  const getIdentityForSession = useCallback(
    (session: DaemonSessionSummary) =>
      getSessionIdentity(
        session.sessionId,
        session.workspaceCwd || primaryWorkspaceCwd,
      ),
    [primaryWorkspaceCwd],
  );
  const isCurrentSession = useCallback(
    (session: DaemonSessionSummary) =>
      currentSessionIdentity === getIdentityForSession(session),
    [currentSessionIdentity, getIdentityForSession],
  );
  const canMutateSessionArchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionWorkspace = displayedWorkspaces.find(
        (entry) => entry.cwd === session.workspaceCwd,
      );
      if (sessionWorkspace?.trusted === false) return false;
      return (
        sessionArchiveEnabled &&
        (sessionWorkspace?.primary !== false ||
          workspaceQualifiedRestCoreEnabled)
      );
    },
    [
      displayedWorkspaces,
      sessionArchiveEnabled,
      workspaceQualifiedRestCoreEnabled,
    ],
  );
  const getArchivedExportWorkspaceCwd = useCallback(
    (session: DaemonSessionSummary) => {
      const workspaceCwd = session.workspaceCwd || primaryWorkspaceCwd;
      const sessionWorkspace = displayedWorkspaces.find(
        (entry) => entry.cwd === workspaceCwd,
      );
      return canExportArchivedSessions && sessionWorkspace?.trusted === true
        ? sessionWorkspace.cwd
        : undefined;
    },
    [canExportArchivedSessions, displayedWorkspaces, primaryWorkspaceCwd],
  );

  useEffect(() => {
    if (!organizationEnabled) {
      setSecondaryPinnedSessions([]);
      return;
    }
    const secondaryWorkspaces = displayedWorkspaces.filter(
      (entry) => !entry.primary && entry.trusted,
    );
    let cancelled = false;
    void Promise.allSettled(
      secondaryWorkspaces.map(async (entry) => {
        const result = await workspace.client
          .workspaceByCwd(entry.cwd)
          .listWorkspaceSessions({
            pageSize: SESSION_LIST_PAGE_SIZE,
            archiveState: 'active',
            view: 'organized',
            group: 'pinned',
          });
        return result.map((session) => ({
          ...session,
          workspaceCwd: entry.cwd,
        }));
      }),
    ).then((results) => {
      if (cancelled) return;
      setSecondaryPinnedSessions(
        results.flatMap((result) =>
          result.status === 'fulfilled' ? result.value : [],
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [
    displayedWorkspaces,
    organizationEnabled,
    workspace.client,
    workspaceSessionsReloadToken,
  ]);
  const allArchivedSessions = useMemo(() => {
    const byIdentity = new Map<string, DaemonSessionSummary>();
    for (const session of [
      ...(includePrimaryWorkspaceSessions ? archivedSessions : []),
      ...secondaryArchivedSessions,
    ]) {
      byIdentity.set(getIdentityForSession(session), session);
    }
    return [...byIdentity.values()];
  }, [
    archivedSessions,
    getIdentityForSession,
    includePrimaryWorkspaceSessions,
    secondaryArchivedSessions,
  ]);
  const effectiveArchivedLoading =
    (includePrimaryWorkspaceSessions && archivedLoading) ||
    secondaryArchivedLoading;
  const effectiveArchivedError =
    (includePrimaryWorkspaceSessions && Boolean(archivedError)) ||
    secondaryArchivedError;

  useEffect(() => {
    if (!archivedExpanded) return;
    if (!sessionArchiveEnabled || !workspaceQualifiedRestCoreEnabled) {
      setSecondaryArchivedSessions([]);
      setSecondaryArchivedLoading(false);
      setSecondaryArchivedError(false);
      return;
    }
    const secondaryWorkspaces = displayedWorkspaces.filter(
      (entry) => !entry.primary && entry.trusted,
    );
    if (secondaryWorkspaces.length === 0) {
      setSecondaryArchivedSessions([]);
      setSecondaryArchivedLoading(false);
      setSecondaryArchivedError(false);
      return;
    }
    let cancelled = false;
    setSecondaryArchivedLoading(true);
    void Promise.allSettled(
      secondaryWorkspaces.map(async (entry) => {
        const sessions = await workspace.client
          .workspaceByCwd(entry.cwd)
          .listWorkspaceSessions({
            pageSize: SESSION_LIST_PAGE_SIZE,
            archiveState: 'archived',
            ...(organizationEnabled
              ? { view: 'organized' as const, group: 'all' }
              : {}),
          });
        return sessions.map((session) => ({
          ...session,
          workspaceCwd: entry.cwd,
        }));
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const failures = results.filter(
          (result) => result.status === 'rejected',
        );
        setSecondaryArchivedSessions(
          results.flatMap((result) =>
            result.status === 'fulfilled' ? result.value : [],
          ),
        );
        setSecondaryArchivedError(failures.length > 0);
        for (const failure of failures) {
          console.warn(
            '[WebShellSidebar] archived session load failed:',
            failure.reason,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSecondaryArchivedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    archivedExpanded,
    displayedWorkspaces,
    organizationEnabled,
    secondaryArchivedReloadToken,
    sessionArchiveEnabled,
    workspace.client,
    workspaceQualifiedRestCoreEnabled,
    workspaceSessionsReloadToken,
  ]);
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

  const setSessionBusy = useCallback(
    (sessionId: string, busy: boolean, workspaceCwd?: string) => {
      const identity = getSessionIdentity(
        sessionId,
        workspaceCwd || primaryWorkspaceCwd,
      );
      const next = new Set(busySessionIdsRef.current);
      if (busy) {
        next.add(identity);
      } else {
        next.delete(identity);
      }
      busySessionIdsRef.current = next;
      setBusySessionIds(next);
    },
    [primaryWorkspaceCwd],
  );

  const reloadGroups = useCallback(async () => {
    if (!organizationEnabled) {
      setGroups([]);
      setColorOptions([]);
      setGroupsCatalogReady(true);
      return;
    }
    try {
      const catalog = await workspaceActions.listSessionGroups();
      setGroups(catalog.groups);
      setMenuGroups(catalog.groups);
      setColorOptions(catalog.colorOptions);
      // Empty catalogs still settle the latch — sessions/groups hydrate on
      // independent requests, so readiness cannot wait for a non-empty list.
      // Failures must not settle it (see sessionsCatalogReady above).
      setGroupsCatalogReady(true);
    } catch (err) {
      onError(err, t('sidebar.groupsLoadFailed'));
    }
  }, [onError, organizationEnabled, t, workspaceActions]);

  useEffect(() => {
    if (!organizationEnabled) {
      setGroups([]);
      setColorOptions([]);
      setGroupsCatalogReady(true);
      return;
    }
    setGroupsCatalogReady(false);
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
        getIdentityForSession(session),
        Boolean(session.hasActivePrompt),
      ]),
    );
    const previousRunningBySessionId = previousRunningRef.current;
    previousRunningRef.current = runningBySessionId;
    if (previousRunningBySessionId === null) return;

    setCompletedUnreadIds((current) => {
      const next = new Set(current);
      let changed = false;

      for (const [sessionIdentity, wasRunning] of previousRunningBySessionId) {
        const isRunning = runningBySessionId.get(sessionIdentity);
        if (
          wasRunning &&
          isRunning === false &&
          sessionIdentity !== currentSessionIdentity &&
          !next.has(sessionIdentity)
        ) {
          next.add(sessionIdentity);
          changed = true;
        }
      }

      for (const sessionIdentity of next) {
        if (
          sessionIdentity === currentSessionIdentity ||
          !runningBySessionId.has(sessionIdentity) ||
          runningBySessionId.get(sessionIdentity)
        ) {
          next.delete(sessionIdentity);
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [currentSessionIdentity, getIdentityForSession, sessions]);

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

  const handleSuggestWorkspacePaths = useCallback(
    (prefix: string) => workspaceActions.suggestWorkspacePaths(prefix),
    [workspaceActions],
  );

  const reconcileRemovedWorkspace = useCallback(
    async (removed: DaemonWorkspaceCapability) => {
      if (!workspaceRemovalMountedRef.current) return;
      if (selectedWorkspaceCwd === removed.cwd) {
        onSelectWorkspace?.(undefined);
      }
      setWorkspaceSessionsReloadToken((token) => token + 1);
      try {
        await workspace.refreshCapabilities?.();
      } catch {
        // The mutation already converged; a later refresh will reconcile.
      }
      if (!workspaceRemovalMountedRef.current) return;
      setWorkspaceRemovalCandidate(null);
      setWorkspaceRemovalActivity(null);
      setWorkspaceRemovalRemoteInProgress(false);
      void reload().catch(() => undefined);
      void reloadArchived().catch(() => undefined);
    },
    [
      onSelectWorkspace,
      reload,
      reloadArchived,
      selectedWorkspaceCwd,
      workspace,
    ],
  );

  const requestWorkspaceRemoval = useCallback(
    (candidate: DaemonWorkspaceCapability) => {
      if (workspaceRemovalSubmitting) return;
      workspaceRemovalDismissedRef.current = false;
      setWorkspaceRemovalActivity(null);
      setWorkspaceRemovalRemoteInProgress(false);
      setWorkspaceRemovalCandidate(candidate);
    },
    [workspaceRemovalSubmitting],
  );

  const confirmWorkspaceRemoval = useCallback(async () => {
    const candidate = workspaceRemovalCandidate;
    if (!candidate || workspaceRemovalSubmitting) return;
    const force = workspaceRemovalActivity !== null;
    if (
      force &&
      connection.sessionId &&
      connection.workspaceCwd === candidate.cwd
    ) {
      return;
    }
    setWorkspaceRemovalSubmitting(true);
    try {
      await workspaceActions.removeWorkspace(candidate.id, { force });
      await reconcileRemovedWorkspace(candidate);
    } catch (error) {
      if (!workspaceRemovalMountedRef.current) return;
      if (error instanceof DaemonHttpError) {
        const body = error.body as
          | {
              code?: unknown;
              activity?: DaemonWorkspaceRemovalActivity;
            }
          | undefined;
        if (
          error.status === 409 &&
          body?.code === 'workspace_busy' &&
          body.activity
        ) {
          setWorkspaceRemovalActivity(body.activity);
          return;
        }
        if (error.status === 400 && body?.code === 'workspace_mismatch') {
          await reconcileRemovedWorkspace(candidate);
          return;
        }
        if (
          error.status === 409 &&
          (body?.code === 'workspace_removal_in_progress' ||
            body?.code === 'workspace_registration_in_progress')
        ) {
          setWorkspaceRemovalRemoteInProgress(true);
          let lastError: unknown = error;
          let exhaustedTransientRetries = true;
          for (let attempt = 0; attempt < 20; attempt++) {
            if (
              !workspaceRemovalMountedRef.current ||
              workspaceRemovalDismissedRef.current
            ) {
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            if (
              !workspaceRemovalMountedRef.current ||
              workspaceRemovalDismissedRef.current
            ) {
              return;
            }
            try {
              await workspaceActions.removeWorkspace(candidate.id, { force });
              await reconcileRemovedWorkspace(candidate);
              return;
            } catch (retryError) {
              if (!workspaceRemovalMountedRef.current) return;
              lastError = retryError;
              if (retryError instanceof DaemonHttpError) {
                const retryBody = retryError.body as
                  | {
                      code?: unknown;
                      activity?: DaemonWorkspaceRemovalActivity;
                    }
                  | undefined;
                if (
                  retryError.status === 400 &&
                  retryBody?.code === 'workspace_mismatch'
                ) {
                  await reconcileRemovedWorkspace(candidate);
                  return;
                }
                if (
                  retryError.status === 409 &&
                  retryBody?.code === 'workspace_busy' &&
                  retryBody.activity
                ) {
                  setWorkspaceRemovalRemoteInProgress(false);
                  setWorkspaceRemovalActivity(retryBody.activity);
                  return;
                }
                if (
                  retryError.status === 409 &&
                  (retryBody?.code === 'workspace_removal_in_progress' ||
                    retryBody?.code === 'workspace_registration_in_progress')
                ) {
                  continue;
                }
              }
              exhaustedTransientRetries = false;
              break;
            }
          }
          if (
            !workspaceRemovalMountedRef.current ||
            workspaceRemovalDismissedRef.current
          ) {
            return;
          }
          setWorkspaceRemovalRemoteInProgress(false);
          onError(
            exhaustedTransientRetries
              ? new Error(
                  'Workspace removal remained in progress after retries.',
                )
              : lastError,
            t('sidebar.removeWorkspaceError'),
          );
          return;
        }
      }
      onError(error, t('sidebar.removeWorkspaceError'));
    } finally {
      if (workspaceRemovalMountedRef.current) {
        setWorkspaceRemovalSubmitting(false);
      }
    }
  }, [
    connection.sessionId,
    connection.workspaceCwd,
    onError,
    reconcileRemovedWorkspace,
    t,
    workspaceActions,
    workspaceRemovalActivity,
    workspaceRemovalCandidate,
    workspaceRemovalSubmitting,
  ]);

  const handleNewSession = useCallback(
    (workspaceCwd?: string, opts?: { worktree?: { slug?: string } }) => {
      if (creatingSessionRef.current) return;

      creatingSessionRef.current = true;
      setCreatingSession(true);
      void (async () => {
        try {
          const created = await onNewSession(workspaceCwd, opts);
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
      const sessionIdentity = getSessionIdentity(
        sessionId,
        workspaceCwd || primaryWorkspaceCwd,
      );
      if (sessionIdentity === currentSessionIdentity) {
        onSelectCurrentSession?.();
        return;
      }
      if (busySessionIdsRef.current.has(sessionIdentity)) return;
      setCompletedUnreadIds((current) => {
        if (!current.has(sessionIdentity)) return current;
        const next = new Set(current);
        next.delete(sessionIdentity);
        return next;
      });
      setSessionBusy(sessionId, true, workspaceCwd);
      void (async () => {
        try {
          await onLoadSession(sessionId, workspaceCwd);
        } catch (err) {
          if (!isAbortError(err)) {
            onError(err, t('sidebar.switchFailed'));
          }
        } finally {
          setSessionBusy(sessionId, false, workspaceCwd);
        }
      })();
    },
    [
      currentSessionIdentity,
      onError,
      onLoadSession,
      onSelectCurrentSession,
      primaryWorkspaceCwd,
      setSessionBusy,
      t,
    ],
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
    if (
      busySessionIdsRef.current.has(
        getSessionIdentity(sessionId, connection.workspaceCwd),
      )
    ) {
      return;
    }
    setSessionBusy(sessionId, true, connection.workspaceCwd);
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
        setSessionBusy(sessionId, false, connection.workspaceCwd);
      });
  }, [
    actions,
    bumpWorkspaceReload,
    cancelRename,
    connection.workspaceCwd,
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
      if (isCurrentSession(session)) return;
      setDeleteCandidate(session);
    },
    [isCurrentSession],
  );

  const setSessionExporting = useCallback(
    (sessionId: string, exporting: boolean, workspaceCwd?: string) => {
      const identity = getSessionIdentity(
        sessionId,
        workspaceCwd || primaryWorkspaceCwd,
      );
      const next = new Set(exportingSessionIdsRef.current);
      if (exporting) {
        next.add(identity);
      } else {
        next.delete(identity);
      }
      exportingSessionIdsRef.current = next;
      setExportingSessionIds(next);
    },
    [primaryWorkspaceCwd],
  );

  const handleExportSession = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      const archived = session.isArchived === true;
      if (
        (archived
          ? !getArchivedExportWorkspaceCwd(session)
          : !canExportSessions) ||
        exportingSessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setSessionExporting(sessionId, true, session.workspaceCwd);
      void (async () => {
        try {
          let result;
          if (archived) {
            const workspaceCwd = getArchivedExportWorkspaceCwd(session);
            if (!workspaceCwd) return;
            result = await workspace.client
              .workspaceByCwd(workspaceCwd)
              .exportArchivedSession(sessionId, { format: 'html' });
          } else {
            result = await exportSession(sessionId, 'html');
          }
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
          setSessionExporting(sessionId, false, session.workspaceCwd);
        }
      })();
    },
    [
      canExportSessions,
      exportSession,
      getArchivedExportWorkspaceCwd,
      getIdentityForSession,
      onError,
      setSessionExporting,
      t,
      workspace.client,
    ],
  );

  const confirmDeleteSession = useCallback(() => {
    if (!deleteCandidate) return;
    const sessionId = deleteCandidate.sessionId;
    const sessionIdentity = getIdentityForSession(deleteCandidate);
    if (isCurrentSession(deleteCandidate)) {
      setDeleteCandidate(null);
      return;
    }
    const isArchived = Boolean(deleteCandidate.isArchived);
    setDeleteCandidate(null);
    if (busySessionIdsRef.current.has(sessionIdentity)) return;
    setSessionBusy(sessionId, true, deleteCandidate.workspaceCwd);
    const removeSession = !isPrimaryWorkspaceCwd(deleteCandidate.workspaceCwd)
      ? (id: string) =>
          workspace.client
            .workspaceByCwd(deleteCandidate.workspaceCwd!)
            .deleteSessionsData([id])
      : isArchived
        ? deleteArchivedSession
        : deleteSession;
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
        setSessionBusy(sessionId, false, deleteCandidate.workspaceCwd);
      });
  }, [
    bumpWorkspaceReload,
    deleteArchivedSession,
    deleteCandidate,
    deleteSession,
    getIdentityForSession,
    isCurrentSession,
    isPrimaryWorkspaceCwd,
    onError,
    reload,
    reloadArchived,
    setSessionBusy,
    t,
    workspace.client,
  ]);

  const handleRenameFromMenu = useCallback(
    (session: DaemonSessionSummary) => {
      if (!isCurrentSession(session)) return;
      startRename(session);
    },
    [isCurrentSession, startRename],
  );

  const handleCreateGroup = useCallback(() => {
    setGroupMenu(null);
    setGroupName('');
    setGroupColor(getDefaultGroupColor(colorOptions));
    setLastValidCustomGroupColor(DEFAULT_CUSTOM_GROUP_COLOR);
    setGroupEditor({ mode: 'create' });
  }, [colorOptions]);

  const handleCreateWorkspaceGroup = useCallback(
    (workspaceCwd: string) => {
      void (async () => {
        try {
          const catalog = await workspace.client
            .workspaceByCwd(workspaceCwd)
            .listSessionGroups();
          setGroupMenu(null);
          setGroupName('');
          setGroupColor(getDefaultGroupColor(catalog.colorOptions));
          setLastValidCustomGroupColor(DEFAULT_CUSTOM_GROUP_COLOR);
          setGroupEditor({ mode: 'create', workspaceCwd });
        } catch (err) {
          onError(err, t('sidebar.groupsLoadFailed'));
        }
      })();
    },
    [onError, t, workspace.client],
  );

  const handleCreateGroupForSession = useCallback(
    (session: DaemonSessionSummary) => {
      setGroupMenu(null);
      setGroupName('');
      setGroupColor(getDefaultGroupColor(colorOptions));
      setLastValidCustomGroupColor(DEFAULT_CUSTOM_GROUP_COLOR);
      setGroupEditor({
        mode: 'create',
        targetSession: session,
        workspaceCwd: session.workspaceCwd,
      });
    },
    [colorOptions],
  );

  const handleRenameGroup = useCallback(
    (group: DaemonSessionGroup, workspaceCwd?: string) => {
      setGroupName(group.name);
      setGroupColor(group.color);
      setLastValidCustomGroupColor(
        normalizeHexColorInput(group.color) ?? DEFAULT_CUSTOM_GROUP_COLOR,
      );
      setGroupEditor({ mode: 'edit', group, workspaceCwd });
    },
    [],
  );

  const closeGroupEditor = useCallback(() => {
    if (groupBusy) return;
    setGroupEditor(null);
    setGroupName('');
    setGroupColor(getDefaultGroupColor(colorOptions));
    setLastValidCustomGroupColor(DEFAULT_CUSTOM_GROUP_COLOR);
  }, [colorOptions, groupBusy]);

  const saveGroupEditor = useCallback(() => {
    if (!groupEditor) return;
    const name = groupName.trim();
    const color = normalizeGroupColorInput(
      groupColor,
      colorOptions.length > 0 ? colorOptions : SESSION_GROUP_COLORS,
    );
    if (!name || !color) return;
    void (async () => {
      setGroupBusy(true);
      try {
        const groupActions = !isPrimaryWorkspaceCwd(groupEditor.workspaceCwd)
          ? workspace.client.workspaceByCwd(groupEditor.workspaceCwd!)
          : workspaceActions;
        const group =
          groupEditor.mode === 'create'
            ? await groupActions.createSessionGroup({
                name,
                color,
              })
            : await groupActions.updateSessionGroup(groupEditor.group!.id, {
                name,
                color,
              });
        if (groupEditor.mode === 'create') {
          if (groupEditor.targetSession) {
            try {
              await groupActions.updateSessionOrganization(
                groupEditor.targetSession.sessionId,
                // Assigning a named group clears any color tag (single choice
                // in the UI), matching assignSessionGroup.
                { groupId: group.id, color: null },
              );
              if (!groupEditor.workspaceCwd) {
                void reload().catch(() => undefined);
              }
              bumpWorkspaceReload();
            } catch (err) {
              setGroupEditor(null);
              setGroupName('');
              if (!groupEditor.workspaceCwd) {
                void reloadGroups().catch(() => undefined);
              }
              onError(err, t('sidebar.groupAssignFailedAfterCreate'));
              return;
            }
          }
        }
        setGroupEditor(null);
        setGroupName('');
        if (groupEditor.workspaceCwd) {
          bumpWorkspaceReload();
        } else {
          void reloadGroups().catch(() => undefined);
        }
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
    colorOptions,
    groupColor,
    groupEditor,
    groupName,
    isPrimaryWorkspaceCwd,
    onError,
    reload,
    reloadGroups,
    t,
    workspaceActions,
    workspace.client,
  ]);

  const handleDeleteGroup = useCallback(
    (group: DaemonSessionGroup, workspaceCwd?: string) => {
      setDeleteGroupCandidate({ group, workspaceCwd });
    },
    [],
  );

  const confirmDeleteGroup = useCallback(() => {
    if (!deleteGroupCandidate) return;
    setGroupBusy(true);
    const groupActions = !isPrimaryWorkspaceCwd(
      deleteGroupCandidate.workspaceCwd,
    )
      ? workspace.client.workspaceByCwd(deleteGroupCandidate.workspaceCwd!)
      : workspaceActions;
    groupActions
      .deleteSessionGroup(deleteGroupCandidate.group.id)
      .then(() => {
        setDeleteGroupCandidate(null);
        if (deleteGroupCandidate.workspaceCwd) bumpWorkspaceReload();
        else void reload().catch(() => undefined);
      })
      .catch((err: unknown) => onError(err, t('sidebar.groupDeleteFailed')))
      .then(() =>
        deleteGroupCandidate.workspaceCwd
          ? undefined
          : reloadGroups().catch(() => undefined),
      )
      .finally(() => setGroupBusy(false));
  }, [
    deleteGroupCandidate,
    isPrimaryWorkspaceCwd,
    onError,
    reload,
    reloadGroups,
    t,
    bumpWorkspaceReload,
    workspace.client,
    workspaceActions,
  ]);

  const handleTogglePin = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (
        !organizationEnabled ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      sessionActions
        .updateSessionOrganization(sessionId, {
          isPinned: !session.isPinned,
        })
        .then(() => {
          void reload().catch(() => undefined);
          void reloadPinnedSessions().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      organizationEnabled,
      reload,
      reloadPinnedSessions,
      setSessionBusy,
      t,
    ],
  );

  const handleArchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      // The daemon force-ends a live turn on archive; keep the current
      // session off-limits, mirroring the delete guard.
      if (!canMutateSessionArchive(session) || isCurrentSession(session))
        return;
      if (busySessionIdsRef.current.has(sessionIdentity)) return;
      setSessionBusy(sessionId, true, session.workspaceCwd);
      void (async () => {
        try {
          if (!isPrimaryWorkspaceCwd(session.workspaceCwd)) {
            const result = await workspace.client
              .workspaceByCwd(session.workspaceCwd)
              .archiveSessionsData([sessionId]);
            const itemError = result.errors.find(
              (entry) => entry.sessionId === sessionId,
            );
            if (itemError) {
              onError(new Error(itemError.error), t('sidebar.archiveFailed'));
            }
          } else {
            await archiveSession(sessionId);
          }
        } catch (err) {
          onError(err, t('sidebar.archiveFailed'));
        } finally {
          void reload().catch(() => undefined);
          void reloadArchived().catch(() => undefined);
          bumpWorkspaceReload();
          setSessionBusy(sessionId, false, session.workspaceCwd);
        }
      })();
    },
    [
      archiveSession,
      bumpWorkspaceReload,
      canMutateSessionArchive,
      getIdentityForSession,
      isPrimaryWorkspaceCwd,
      isCurrentSession,
      onError,
      reload,
      reloadArchived,
      setSessionBusy,
      t,
      workspace.client,
    ],
  );

  const handleUnarchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (!canMutateSessionArchive(session)) return;
      if (busySessionIdsRef.current.has(sessionIdentity)) return;
      setSessionBusy(sessionId, true, session.workspaceCwd);
      void (async () => {
        try {
          if (!isPrimaryWorkspaceCwd(session.workspaceCwd)) {
            const result = await workspace.client
              .workspaceByCwd(session.workspaceCwd)
              .unarchiveSessionsData([sessionId]);
            const itemError = result.errors.find(
              (entry) => entry.sessionId === sessionId,
            );
            if (itemError) {
              onError(new Error(itemError.error), t('sidebar.unarchiveFailed'));
            }
          } else {
            await unarchiveSession(sessionId);
          }
        } catch (err) {
          onError(err, t('sidebar.unarchiveFailed'));
        } finally {
          void reload().catch(() => undefined);
          void reloadArchived().catch(() => undefined);
          bumpWorkspaceReload();
          setSessionBusy(sessionId, false, session.workspaceCwd);
        }
      })();
    },
    [
      bumpWorkspaceReload,
      canMutateSessionArchive,
      getIdentityForSession,
      isPrimaryWorkspaceCwd,
      onError,
      reload,
      reloadArchived,
      setSessionBusy,
      t,
      unarchiveSession,
      workspace.client,
    ],
  );

  const openGroupMenuFromAnchor = useCallback(
    async (anchorEl: HTMLElement, session: DaemonSessionSummary) => {
      let groupCount = 0;
      try {
        const catalog =
          await getSessionWorkspaceActions(session).listSessionGroups();
        setMenuGroups(catalog.groups);
        setColorOptions(catalog.colorOptions);
        groupCount = catalog.groups.length;
      } catch (err) {
        onError(err, t('sidebar.groupsLoadFailed'));
        return;
      }
      if (!anchorEl.isConnected) return;
      const rect = anchorEl.getBoundingClientRect();
      const viewportWidth =
        typeof window === 'undefined'
          ? rect.right + GROUP_MENU_WIDTH
          : window.innerWidth;
      const viewportHeight =
        typeof window === 'undefined' ? rect.top + 320 : window.innerHeight;
      const estimatedHeight = Math.min(
        320,
        34 * (groupCount + SESSION_GROUP_COLORS.length + 2) + 25,
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
    [getSessionWorkspaceActions, onError, t],
  );

  const assignSessionGroup = useCallback(
    (session: DaemonSessionSummary, groupId: string | null) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (
        !organizationEnabled ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      sessionActions
        // Group and color are a single choice in the UI: assigning a named
        // group (or "Ungrouped", groupId=null) clears any color tag.
        .updateSessionOrganization(sessionId, { groupId, color: null })
        .then(() => {
          void reload().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      organizationEnabled,
      reload,
      setSessionBusy,
      t,
    ],
  );

  const assignSessionColor = useCallback(
    (
      session: DaemonSessionSummary,
      color: DaemonSessionGroupPresetColor | null,
    ) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (
        !organizationEnabled ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      sessionActions
        // Picking a color clears any named-group assignment (single choice).
        .updateSessionOrganization(sessionId, { color, groupId: null })
        .then(() => {
          void reload().catch(() => undefined);
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      organizationEnabled,
      reload,
      setSessionBusy,
      t,
    ],
  );

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const unpinnedSessions = sessions.filter((session) => !session.isPinned);
    const nextSessions = query
      ? unpinnedSessions.filter((session) => {
          const label = getSessionLabel(session).toLowerCase();
          return (
            label.includes(query) ||
            session.sessionId.toLowerCase().includes(query)
          );
        })
      : unpinnedSessions.slice();
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
      DaemonSessionGroupPresetColor,
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
    if (!organizationEnabled) return;
    // Wait for both independent catalog sources. Flipping the latch on the
    // first non-empty derived sections would treat later initial recent/color
    // ids as brand-new and auto-collapse them; leaving the latch set when the
    // first ready catalog is empty would leave the first real section expanded.
    if (!groupsCatalogReady || !sessionsCatalogReady) return;

    const unseenIds = sessionSections
      .map((section) => section.id)
      .filter((id) => !knownSessionSectionIdsRef.current.has(id));
    const isInitialCatalog = awaitingInitialSessionCatalogRef.current;
    if (isInitialCatalog) {
      awaitingInitialSessionCatalogRef.current = false;
      for (const id of unseenIds) knownSessionSectionIdsRef.current.add(id);
      return;
    }
    if (unseenIds.length === 0) return;
    for (const id of unseenIds) knownSessionSectionIdsRef.current.add(id);
    // Brand-new sections that appear mid-session still start collapsed.
    setCollapsedSessionSectionIds((current) => {
      const next = new Set(current);
      for (const id of unseenIds) next.add(id);
      return next;
    });
  }, [
    groupsCatalogReady,
    organizationEnabled,
    sessionSections,
    sessionsCatalogReady,
  ]);

  useEffect(() => {
    replaceOwnedCollapsedSessionSectionIds(
      collapsedSessionSectionIds,
      isPrimaryCollapsedSectionId,
    );
  }, [collapsedSessionSectionIds]);

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
    menuGroups.some((group) => group.id === groupMenu.session.groupId)
      ? groupMenu.session.groupId
      : null;
  const menuColorOptions =
    colorOptions.length > 0 ? colorOptions : SESSION_GROUP_COLORS;
  const groupMenuUngroupedSelected =
    groupMenuSelectedGroupId === null && groupMenuSelectedColor === null;
  const deleteGroupCandidateLabel = deleteGroupCandidate?.group.name ?? '';
  const groupColorChoices =
    colorOptions.length > 0
      ? colorOptions
      : (['blue'] as DaemonSessionGroupPresetColor[]);
  const normalizedGroupColor = normalizeGroupColorInput(
    groupColor,
    groupColorChoices,
  );
  const customGroupColor = !groupColorChoices.includes(
    groupColor as DaemonSessionGroupPresetColor,
  );
  const canSaveGroup =
    groupName.trim().length > 0 &&
    normalizedGroupColor !== undefined &&
    !groupBusy;
  const groupEditorTitle =
    groupEditor?.mode === 'create'
      ? t('sidebar.groupCreate')
      : t('sidebar.groupRename');

  const renderSessionRow = useCallback(
    (
      session: DaemonSessionSummary,
      options: {
        isArchived?: boolean;
        // Suppress per-session mutations other than an explicitly supported
        // archive action. Secondary workspace rows remain otherwise load-only.
        readOnly?: boolean;
      } = {},
    ) => {
      const { isArchived = false, readOnly = false } = options;
      const sessionIdentity = getIdentityForSession(session);
      const label = getSessionLabel(session);
      const stamp = session.updatedAt || session.createdAt;
      const time = stamp ? formatRelativeTime(stamp, t) : '';
      const busy = busySessionIds.has(sessionIdentity);
      const exporting = exportingSessionIds.has(sessionIdentity);
      const completedUnread =
        !isCurrentSession(session) && completedUnreadIds.has(sessionIdentity);
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
            key={sessionIdentity}
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
                      {getArchivedExportWorkspaceCwd(session) && (
                        <DropdownMenuItem
                          disabled={exporting}
                          onSelect={() => handleExportSession(session)}
                        >
                          <DownloadIcon />
                          {t('sidebar.export')}
                        </DropdownMenuItem>
                      )}
                      {canMutateSessionArchive(session) && (
                        <DropdownMenuItem
                          onSelect={() => handleUnarchive(session)}
                        >
                          <ArchiveRestoreIcon />
                          {t('sidebar.unarchive')}
                        </DropdownMenuItem>
                      )}
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

      const isCurrent = isCurrentSession(session);
      const isEditing = isCurrent && editingSessionId === session.sessionId;
      const needsUserInput =
        !session.isWaitingForPermission && session.isWaitingForUserQuestion;
      const attentionLabel = session.isWaitingForPermission
        ? t('sidebar.waitingForApproval')
        : needsUserInput
          ? t('sidebar.userInputNeeded')
          : null;
      return (
        <div
          key={sessionIdentity}
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
                  <span className={styles.sessionText}>
                    {session.worktree && (
                      <GitForkIcon
                        size={11}
                        strokeWidth={1.5}
                        className={styles.sessionBadgeIcon}
                        aria-label={t('sidebar.newWorktreeTask')}
                      />
                    )}
                    {label}
                  </span>
                  <div className={styles.sessionMetaSlot}>
                    {attentionLabel && (
                      <span
                        className={cx(
                          styles.sessionAttention,
                          needsUserInput && styles.sessionAttentionUserInput,
                        )}
                        aria-label={attentionLabel}
                      >
                        {attentionLabel}
                      </span>
                    )}
                    {session.hasActivePrompt ? (
                      <span
                        className={styles.sessionLoading}
                        aria-label={t('sidebar.running')}
                      />
                    ) : !attentionLabel ? (
                      <span className={styles.sessionTime}>{time}</span>
                    ) : null}
                    {readOnly && canMutateSessionArchive(session) && (
                      <div
                        className={styles.sessionActions}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
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
                      </div>
                    )}
                    {!readOnly && (
                      <div
                        className={styles.sessionActions}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {(() => {
                          const inlineActions: Array<{
                            key: WebShellSidebarSessionInlineActionItem;
                            icon?: ReactNode;
                            label: string;
                            disabled?: boolean;
                            title?: string;
                            active?: boolean;
                            destructive?: boolean;
                            visible: boolean;
                            onClick: () => void;
                          }> = [
                            {
                              key: 'pin',
                              icon: <PinIcon size={16} strokeWidth={1.2} />,
                              label: session.isPinned
                                ? t('sidebar.unpin')
                                : t('sidebar.pin'),
                              disabled: busy,
                              active: session.isPinned,
                              visible:
                                organizationEnabled &&
                                sessionActionItems.has('pin') &&
                                inlineActionItems.has('pin'),
                              onClick: () => handleTogglePin(session),
                            },
                            {
                              key: 'archive',
                              icon: <ArchiveIcon size={16} strokeWidth={1.2} />,
                              label: t('sidebar.archive'),
                              disabled: busy || isCurrent,
                              title: isCurrent
                                ? t('sidebar.archiveCurrentDisabled')
                                : t('sidebar.archive'),
                              visible:
                                canMutateSessionArchive(session) &&
                                sessionActionItems.has('archive') &&
                                inlineActionItems.has('archive'),
                              onClick: () => handleArchive(session),
                            },
                            {
                              key: 'rename',
                              icon: <PencilIcon size={16} strokeWidth={1.2} />,
                              label: t('sidebar.rename'),
                              disabled: !isCurrent,
                              title: !isCurrent
                                ? t('sidebar.renameCurrentOnly')
                                : undefined,
                              visible:
                                sessionActionItems.has('rename') &&
                                inlineActionItems.has('rename'),
                              onClick: () => handleRenameFromMenu(session),
                            },
                            {
                              key: 'export',
                              icon: (
                                <DownloadIcon size={16} strokeWidth={1.2} />
                              ),
                              label: t('sidebar.export'),
                              disabled: exporting,
                              visible:
                                canExportSessions &&
                                sessionActionItems.has('export') &&
                                inlineActionItems.has('export'),
                              onClick: () => handleExportSession(session),
                            },
                            {
                              key: 'delete',
                              icon: <Trash2Icon size={16} strokeWidth={1.2} />,
                              label: t('sidebar.delete'),
                              disabled: isCurrent,
                              destructive: true,
                              title: isCurrent
                                ? t('sidebar.currentDeleteDisabled')
                                : undefined,
                              visible:
                                sessionActionItems.has('delete') &&
                                inlineActionItems.has('delete'),
                              onClick: () => handleDeleteSession(session),
                            },
                          ];
                          return inlineActions
                            .filter((a) => a.visible)
                            .map((action) => (
                              <button
                                key={action.key}
                                className={cx(
                                  styles.sessionActionButton,
                                  action.active &&
                                    styles.activeSessionActionButton,
                                )}
                                type="button"
                                disabled={action.disabled}
                                aria-label={action.label}
                                title={action.title ?? action.label}
                                onClick={action.onClick}
                                style={
                                  action.destructive && !action.disabled
                                    ? {
                                        color: 'var(--destructive, #dc2626)',
                                      }
                                    : undefined
                                }
                              >
                                {action.icon ?? (
                                  <span style={{ fontSize: 12 }}>
                                    {action.label}
                                  </span>
                                )}
                              </button>
                            ));
                        })()}
                        {(organizationEnabled &&
                          sessionActionItems.has('pin') &&
                          !inlineActionItems.has('pin')) ||
                        (canMutateSessionArchive(session) &&
                          sessionActionItems.has('archive') &&
                          !inlineActionItems.has('archive')) ||
                        sessionActionItems.has('details') ||
                        (sessionActionItems.has('rename') &&
                          !inlineActionItems.has('rename')) ||
                        (organizationEnabled &&
                          sessionActionItems.has('group')) ||
                        (canExportSessions &&
                          sessionActionItems.has('export') &&
                          !inlineActionItems.has('export')) ||
                        (sessionActionItems.has('delete') &&
                          !inlineActionItems.has('delete')) ? (
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
                                if (!sessionMenuPointerDismissRef.current)
                                  return;
                                sessionMenuPointerDismissRef.current = false;
                                event.preventDefault();
                              }}
                            >
                              <DropdownMenuGroup>
                                {organizationEnabled &&
                                  sessionActionItems.has('pin') &&
                                  !inlineActionItems.has('pin') && (
                                    <DropdownMenuItem
                                      disabled={busy}
                                      onSelect={() => handleTogglePin(session)}
                                    >
                                      <PinIcon />
                                      {session.isPinned
                                        ? t('sidebar.unpin')
                                        : t('sidebar.pin')}
                                    </DropdownMenuItem>
                                  )}
                                {canMutateSessionArchive(session) &&
                                  sessionActionItems.has('archive') &&
                                  !inlineActionItems.has('archive') && (
                                    <DropdownMenuItem
                                      disabled={busy || isCurrent}
                                      title={
                                        isCurrent
                                          ? t('sidebar.archiveCurrentDisabled')
                                          : undefined
                                      }
                                      onSelect={() => handleArchive(session)}
                                    >
                                      <ArchiveIcon />
                                      {t('sidebar.archive')}
                                    </DropdownMenuItem>
                                  )}
                                {sessionActionItems.has('details') && (
                                  <DropdownMenuSub>
                                    <DropdownMenuSubTrigger>
                                      <InfoIcon />
                                      {t('sidebar.details')}
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className="min-w-64 p-3">
                                      {details}
                                    </DropdownMenuSubContent>
                                  </DropdownMenuSub>
                                )}
                                {sessionActionItems.has('rename') &&
                                  !inlineActionItems.has('rename') && (
                                    <DropdownMenuItem
                                      disabled={!isCurrent}
                                      title={
                                        !isCurrent
                                          ? t('sidebar.renameCurrentOnly')
                                          : undefined
                                      }
                                      onSelect={() =>
                                        handleRenameFromMenu(session)
                                      }
                                    >
                                      <PencilIcon />
                                      {t('sidebar.rename')}
                                    </DropdownMenuItem>
                                  )}
                                {organizationEnabled &&
                                  sessionActionItems.has('group') && (
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
                                {canExportSessions &&
                                  sessionActionItems.has('export') &&
                                  !inlineActionItems.has('export') && (
                                    <DropdownMenuItem
                                      disabled={exporting}
                                      onSelect={() =>
                                        handleExportSession(session)
                                      }
                                    >
                                      <DownloadIcon />
                                      {t('sidebar.export')}
                                    </DropdownMenuItem>
                                  )}
                                {sessionActionItems.has('delete') &&
                                  !inlineActionItems.has('delete') && (
                                    <DropdownMenuItem
                                      variant="destructive"
                                      disabled={isCurrent}
                                      title={
                                        isCurrent
                                          ? t('sidebar.currentDeleteDisabled')
                                          : undefined
                                      }
                                      onSelect={() =>
                                        handleDeleteSession(session)
                                      }
                                    >
                                      <Trash2Icon />
                                      {t('sidebar.delete')}
                                    </DropdownMenuItem>
                                  )}
                              </DropdownMenuGroup>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
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
      canMutateSessionArchive,
      canExportSessions,
      cancelRename,
      collapsed,
      completedUnreadIds,
      editingName,
      editingSessionId,
      exportingSessionIds,
      getArchivedExportWorkspaceCwd,
      getIdentityForSession,
      handleArchive,
      handleDeleteSession,
      handleExportSession,
      handleLoadSession,
      handleRenameFromMenu,
      handleTogglePin,
      handleUnarchive,
      isCurrentSession,
      openGroupMenuFromAnchor,
      organizationEnabled,
      saveRename,
      sessionActionItems,
      inlineActionItems,
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
        <SessionGroupSection
          key={section.id}
          id={section.id}
          label={section.label}
          count={section.sessions.length}
          color={section.color}
          expanded={expanded}
          onToggle={() => toggleSessionSection(section.id)}
          onRename={
            section.kind === 'group' && group
              ? () => handleRenameGroup(group)
              : undefined
          }
          onDelete={
            section.kind === 'group' && group
              ? () => handleDeleteGroup(group)
              : undefined
          }
          renameLabel={t('sidebar.groupRename')}
          deleteLabel={t('sidebar.groupDelete')}
          actionsDisabled={groupBusy}
        >
          {section.sessions.map((session) => renderSessionRow(session))}
        </SessionGroupSection>
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
    if (!sessionArchiveEnabled || collapsed || searchQuery.trim()) return null;

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
        {archivedExpanded && allArchivedSessions.length > 0 && (
          <span className={styles.archivedCount}>
            {allArchivedSessions.length}
          </span>
        )}
      </button>
    );

    if (!archivedExpanded) {
      return <div className={styles.archivedSection}>{header}</div>;
    }

    const retry = (
      <button
        className={styles.retry}
        type="button"
        onClick={() => {
          void reloadArchived();
          setSecondaryArchivedReloadToken((token) => token + 1);
        }}
      >
        {t('sidebar.loadFailed')}
      </button>
    );
    let content: ReactNode;
    if (effectiveArchivedLoading && allArchivedSessions.length === 0) {
      content = (
        <div className={styles.notice}>{t('sidebar.loadingSessions')}</div>
      );
    } else if (effectiveArchivedError && allArchivedSessions.length === 0) {
      content = retry;
    } else if (allArchivedSessions.length === 0) {
      content = (
        <div className={styles.notice}>{t('sidebar.archivedEmpty')}</div>
      );
    } else {
      content = (
        <>
          {allArchivedSessions.map((session) =>
            renderSessionRow(session, { isArchived: true }),
          )}
          {effectiveArchivedError && retry}
        </>
      );
    }

    return (
      <div className={styles.archivedSection}>
        {header}
        <div className={styles.archivedList}>{content}</div>
      </div>
    );
  }, [
    archivedExpanded,
    allArchivedSessions,
    collapsed,
    effectiveArchivedError,
    effectiveArchivedLoading,
    reloadArchived,
    renderSessionRow,
    searchQuery,
    sessionArchiveEnabled,
    setSecondaryArchivedReloadToken,
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
            {menuGroups.map((group) => {
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
                    style={getGroupColorStyle(group.color)}
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
        {workspaceRemovalCandidate && (
          <DialogShell
            title={t('sidebar.removeWorkspaceTitle')}
            size="sm"
            onClose={() => {
              if (
                !workspaceRemovalSubmitting ||
                workspaceRemovalRemoteInProgress
              ) {
                workspaceRemovalDismissedRef.current = true;
                setWorkspaceRemovalCandidate(null);
                setWorkspaceRemovalActivity(null);
                setWorkspaceRemovalRemoteInProgress(false);
              }
            }}
          >
            <div className={styles.confirmContent}>
              <p className={styles.confirmDescription}>
                {workspaceRemovalActivity
                  ? t('sidebar.removeWorkspaceBusy', {
                      name: workspaceRemovalCandidate.cwd,
                    })
                  : t('sidebar.removeWorkspaceConfirm', {
                      name: workspaceRemovalCandidate.cwd,
                    })}
              </p>
              {workspaceRemovalActivity && (
                <ul className={styles.workspaceRemovalActivityList}>
                  <li>
                    {t('sidebar.removeWorkspaceSessions', {
                      count: workspaceRemovalActivity.sessions,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspacePrompts', {
                      count: workspaceRemovalActivity.activePrompts,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspaceStarts', {
                      count: workspaceRemovalActivity.pendingSessionStarts,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspaceConnections', {
                      count: workspaceRemovalActivity.acpConnections,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspaceMemoryTasks', {
                      count: workspaceRemovalActivity.memoryTasks,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspaceWorkers', {
                      count: workspaceRemovalActivity.channelWorkers,
                    })}
                  </li>
                  <li>
                    {t('sidebar.removeWorkspaceVoiceSessions', {
                      count: workspaceRemovalActivity.voiceSessions ?? 0,
                    })}
                  </li>
                </ul>
              )}
              {workspaceRemovalActivity &&
                connection.sessionId &&
                connection.workspaceCwd === workspaceRemovalCandidate.cwd && (
                  <p className={styles.confirmDescription}>
                    {t('sidebar.removeWorkspaceCurrentSession')}
                  </p>
                )}
              {workspaceRemovalRemoteInProgress && (
                <p className={styles.confirmDescription}>
                  {t('sidebar.removeWorkspaceInProgress')}
                </p>
              )}
              <div className={styles.confirmActions}>
                <button
                  className={styles.secondaryButton}
                  type="button"
                  disabled={
                    workspaceRemovalSubmitting &&
                    !workspaceRemovalRemoteInProgress
                  }
                  onClick={() => {
                    workspaceRemovalDismissedRef.current = true;
                    setWorkspaceRemovalCandidate(null);
                    setWorkspaceRemovalActivity(null);
                    setWorkspaceRemovalRemoteInProgress(false);
                  }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={
                    workspaceRemovalSubmitting ||
                    workspaceRemovalRemoteInProgress ||
                    (workspaceRemovalActivity !== null &&
                      Boolean(connection.sessionId) &&
                      connection.workspaceCwd === workspaceRemovalCandidate.cwd)
                  }
                  onClick={() => void confirmWorkspaceRemoval()}
                >
                  {workspaceRemovalActivity
                    ? t('sidebar.forceRemoveWorkspace')
                    : t('sidebar.removeWorkspace')}
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
                    value={
                      customGroupColor ? CUSTOM_GROUP_COLOR_OPTION : groupColor
                    }
                    onValueChange={(value) => {
                      setGroupColor(
                        value === CUSTOM_GROUP_COLOR_OPTION
                          ? lastValidCustomGroupColor
                          : (value as DaemonSessionGroupPresetColor),
                      );
                    }}
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
                        <SelectItem value={CUSTOM_GROUP_COLOR_OPTION}>
                          {t('sidebar.groupColor.custom')}
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                {customGroupColor && (
                  <Field>
                    <FieldLabel htmlFor="session-group-hex-color">
                      {t('sidebar.groupColor.hex')}
                    </FieldLabel>
                    <div className={styles.groupCustomColorRow}>
                      <Input
                        className={styles.groupColorPicker}
                        type="color"
                        value={lastValidCustomGroupColor}
                        aria-label={t('sidebar.groupColor.picker')}
                        onChange={(event) => {
                          const value =
                            event.target.value.toLowerCase() as DaemonSessionGroupHexColor;
                          setLastValidCustomGroupColor(value);
                          setGroupColor(value);
                        }}
                      />
                      <Input
                        id="session-group-hex-color"
                        value={groupColor}
                        maxLength={7}
                        spellCheck={false}
                        aria-invalid={normalizedGroupColor === undefined}
                        onChange={(event) => {
                          const raw = event.target.value;
                          const trimmed = raw.trim();
                          const value = (
                            trimmed && !trimmed.startsWith('#')
                              ? `#${trimmed}`
                              : raw
                          ) as DaemonSessionGroupColor;
                          setGroupColor(value);
                          const normalized = normalizeHexColorInput(value);
                          if (normalized) {
                            setLastValidCustomGroupColor(normalized);
                          }
                        }}
                      />
                    </div>
                    {normalizedGroupColor === undefined && (
                      <span className={styles.groupColorError} role="alert">
                        {t('sidebar.groupColor.invalid')}
                      </span>
                    )}
                  </Field>
                )}
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
        {shouldRenderBrand && (
          <div className={styles.topRow}>
            {branding?.render ? (
              branding.render()
            ) : (
              <>
                <span className={styles.brandLogo} aria-hidden="true">
                  <IconQwenLogo />
                </span>
                {!collapsed && (
                  <span className={styles.brandName}>Qwen Code</span>
                )}
              </>
            )}
          </div>
        )}
        <div className={styles.primaryNav}>
          {primaryNavItems.has('newTask') && (
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
          )}
          {primaryNavItems.has('plugins') && (
            <button
              className={styles.pluginButton}
              type="button"
              title={t('sidebar.plugins')}
              aria-label={t('sidebar.plugins')}
              onClick={onOpenPlugins}
            >
              <span className={styles.navIcon}>
                <BlocksIcon size={16} strokeWidth={1.2} />
              </span>
              {!collapsed && <span>{t('sidebar.plugins')}</span>}
            </button>
          )}
          {primaryNavItems.has('scheduledTasks') && (
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
          )}
          {primaryNavItems.has('goals') && (
            <button
              className={styles.pluginButton}
              type="button"
              title={t('sidebar.goals')}
              aria-label={t('sidebar.goals')}
              onClick={onOpenGoals}
            >
              <span className={styles.navIcon}>
                <TargetIcon size={16} strokeWidth={1.2} />
              </span>
              {!collapsed && <span>{t('sidebar.goals')}</span>}
            </button>
          )}
          {primaryNavOptions?.render?.()}
        </div>
        <div className={styles.body}>
          <div className={styles.sessionList}>
            {!collapsed && pinnedSessions.length > 0 && (
              <>
                <div className={styles.projectsHeader}>
                  <button
                    className={styles.projectsHeaderToggle}
                    type="button"
                    aria-expanded={pinnedExpanded}
                    onClick={() => setPinnedExpanded((expanded) => !expanded)}
                  >
                    <span>{t('sidebar.pinnedSessions')}</span>
                    <IconChevron expanded={pinnedExpanded} />
                  </button>
                </div>
                {pinnedExpanded && (
                  <div className={styles.pinnedSessionList}>
                    {pinnedSessions.map((session) => renderSessionRow(session))}
                  </div>
                )}
              </>
            )}
            {!collapsed && !hideProjectHeader && (
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
                  {!lockedWorkspaceCwd && (
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
                  )}
                </div>
              </div>
            )}
            {searchOpen && !collapsed && !hideProjectHeader && (
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
            {(collapsed || projectsExpanded) && (
              <>
                {!collapsed && (
                  <div className={styles.workspacePicker}>
                    <div className={styles.workspaceList}>
                      {displayedWorkspaces.map((ws) => (
                        <Fragment key={ws.id}>
                          <WorkspaceSection
                            workspace={ws}
                            renderHeader={
                              lockedWorkspaceCwd &&
                              lockedWorkspaceOptions?.render
                                ? (expanded) =>
                                    lockedWorkspaceOptions.render?.(ws, {
                                      expanded,
                                    })
                                : undefined
                            }
                            client={workspace.client}
                            reloadToken={workspaceSessionsReloadToken}
                            untrustedLabel={t('sidebar.workspaceUntrusted')}
                            readOnlyLabel={t('sidebar.workspaceReadOnly')}
                            trustToOpenLabel={t('sidebar.workspaceTrustToOpen')}
                            noSessionsLabel={t('sidebar.noSessions')}
                            loadErrorLabel={t('sidebar.loadFailed')}
                            organizationEnabled={organizationEnabled}
                            ungroupedLabel={t('sidebar.groupUngrouped')}
                            onRenameGroup={handleRenameGroup}
                            onDeleteGroup={handleDeleteGroup}
                            renameGroupLabel={t('sidebar.groupRename')}
                            deleteGroupLabel={t('sidebar.groupDelete')}
                            groupActionsDisabled={groupBusy}
                            excludePinned
                            onOpenGitDiff={onOpenGitDiff}
                            onNewWorktreeSession={(cwd) =>
                              handleNewSession(ws.primary ? undefined : cwd, {
                                worktree: {},
                              })
                            }
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
                            renderSessions={!ws.primary}
                            renderSession={(session) =>
                              renderSessionRow(
                                {
                                  ...session,
                                  workspaceCwd: ws.cwd,
                                },
                                { readOnly: !ws.primary },
                              )
                            }
                            headerActions={(visible) => {
                              if (
                                lockedWorkspaceCwd &&
                                lockedWorkspaceOptions?.render
                              ) {
                                return null;
                              }
                              const canRemove =
                                !lockedWorkspaceCwd &&
                                workspaceRemovalEnabled &&
                                !ws.primary &&
                                ws.removable === true;
                              if (!ws.trusted && !canRemove) return null;
                              const wsCwd = ws.primary ? undefined : ws.cwd;
                              return (
                                <div
                                  className={styles.workspaceHeaderActions}
                                  style={{
                                    visibility: visible ? 'visible' : 'hidden',
                                  }}
                                >
                                  {ws.trusted && (
                                    <>
                                      <button
                                        className={styles.workspaceHeaderAction}
                                        type="button"
                                        aria-label={t('sidebar.groupCreate')}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          if (ws.primary) {
                                            handleCreateGroup();
                                          } else {
                                            handleCreateWorkspaceGroup(ws.cwd);
                                          }
                                        }}
                                      >
                                        <PlusIcon size={16} strokeWidth={1.2} />
                                      </button>
                                      <button
                                        className={styles.workspaceHeaderAction}
                                        type="button"
                                        title={t('sidebar.newTask')}
                                        aria-label={t('sidebar.newTask')}
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          handleNewSession(wsCwd);
                                        }}
                                      >
                                        <SquarePenIcon
                                          size={16}
                                          strokeWidth={1.2}
                                        />
                                      </button>
                                    </>
                                  )}
                                  {canRemove && (
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <button
                                          className={
                                            styles.workspaceHeaderAction
                                          }
                                          type="button"
                                          aria-label={t(
                                            'sidebar.workspaceActions',
                                          )}
                                          disabled={
                                            workspaceRemovalSubmitting &&
                                            workspaceRemovalCandidate?.id ===
                                              ws.id
                                          }
                                        >
                                          <EllipsisVerticalIcon
                                            size={16}
                                            strokeWidth={1.2}
                                          />
                                        </button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end">
                                        <DropdownMenuItem
                                          variant="destructive"
                                          aria-label={`${t(
                                            'sidebar.removeWorkspace',
                                          )}: ${ws.cwd}`}
                                          onSelect={() =>
                                            requestWorkspaceRemoval(ws)
                                          }
                                        >
                                          <Trash2Icon />
                                          {t('sidebar.removeWorkspace')}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  )}
                                </div>
                              );
                            }}
                          />
                          {ws.primary &&
                          (projectExpanded || searchQuery.trim()) ? (
                            <div className={styles.workspaceSessionBody}>
                              {body}
                            </div>
                          ) : null}
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

        {footer !== false && (
          <div
            className={cx(
              styles.footer,
              footerCompact && styles.footerCompact,
              footerTight && styles.footerTight,
            )}
          >
            <div className={styles.footerPrimary}>
              {typeof footer === 'object' && footer.render?.()}
              {footerItems.has('settings') && (
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
              )}
              {!collapsed &&
                !footerTight &&
                versionLabel &&
                footerItems.has('version') && (
                  <span
                    className={styles.version}
                    title={`Qwen Code ${versionLabel}`}
                  >
                    {versionLabel}
                  </span>
                )}
            </div>
            <div className={styles.footerActions}>
              {footerItems.has('theme') && (
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
              )}
              {canOpenSessionsOverview &&
                footerItems.has('sessionsOverview') && (
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
              {canOpenSplitView && footerItems.has('splitView') && (
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
              {footerItems.has('daemonStatus') && (
                <button
                  className={styles.collapseButton}
                  type="button"
                  title={t('sidebar.daemonStatus')}
                  aria-label={t('sidebar.daemonStatus')}
                  onClick={onOpenDaemonStatus}
                >
                  <ActivityIcon size={16} strokeWidth={1.2} />
                </button>
              )}
              {!mobileOpen && footerItems.has('collapse') && (
                <button
                  className={styles.collapseButton}
                  type="button"
                  title={
                    collapsed ? t('sidebar.expand') : t('sidebar.collapse')
                  }
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
        )}
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-orientation="vertical"
          onPointerDown={handleResizePointerDown}
        />
      </aside>
      {!lockedWorkspaceCwd && showAddWorkspaceDialog && (
        <AddWorkspaceDialog
          onClose={() => setShowAddWorkspaceDialog(false)}
          onAdd={handleAddWorkspace}
          onSuggest={handleSuggestWorkspacePaths}
        />
      )}
    </>
  );
}

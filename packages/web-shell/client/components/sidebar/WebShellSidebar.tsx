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
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useActions,
  useChannels,
  useConnection,
  useWorkspace,
  useWorkspaceActions,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type {
  DaemonSessionGroup,
  DaemonSessionGroupColor,
  DaemonSessionGroupHexColor,
  DaemonSessionGroupPresetColor,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceRemovalActivity,
  SessionMetadataResult,
} from '@qwen-code/sdk/daemon';
import {
  ActivityIcon,
  BlocksIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  LayoutGridIcon,
  ListTodoIcon,
  MessageCircleIcon,
  EllipsisVerticalIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  DownloadIcon,
  FolderClosedIcon,
  FolderInputIcon,
  GitBranchIcon,
  GitForkIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RadioTowerIcon,
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
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
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
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
import { DialogShell } from '../dialogs/DialogShell';
import { WorkspaceSection, isAbsolutePath } from './WorkspaceSection';
import { sessionMatchesGitQuery } from './sessionSearch';
import { SessionPrBadge } from '../SessionPrBadge';
import {
  hasWorkspaceExpansionPreference,
  migrateWorkspaceExpansionPreference,
  readWorkspaceExpanded,
  writeWorkspaceExpanded,
} from './workspaceExpansion';
import { SessionGroupSection } from './SessionGroupSection';
import { SessionDetailsTooltip } from './SessionDetailsTooltip';
import { groupSessionsByChannelType } from './channelSessionGroups';
import {
  isPrimaryCollapsedSectionId,
  readCollapsedSessionSectionIds,
  replaceOwnedCollapsedSessionSectionIds,
} from './collapsedSessionSections';
import { measureSessionTitleScroll } from './sessionTitleScroll';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_ORGANIZATION_FEATURE,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
} from '../../constants/sessions';
import styles from './WebShellSidebar.module.css';
import {
  useSessionCatalogController,
  useSessionCatalogPolling,
  useSessionCatalogQueries,
  useWebShellSessions,
} from '../../session-catalog/session-catalog-hooks';
import { type SessionCatalogQuery } from '../../session-catalog/session-catalog-store';
import { useWorkspaceSessionLiveState } from '../../session-catalog/workspace-session-live-state';

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_MAX_WIDTH_WINDOW_RATIO = 0.5;
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
const SESSION_MENU_PORTAL_STYLE: CSSProperties = {
  zIndex: 'calc(var(--web-shell-popover-z-index, 1000) + 1)',
};
const GROUP_MENU_MARGIN = 8;
const CUSTOM_GROUP_COLOR_OPTION = '__custom__';
const DEFAULT_CUSTOM_GROUP_COLOR: DaemonSessionGroupHexColor = '#416ef5';

type SidebarSessionSource = 'default' | 'channel';

function matchesSessionSource(
  session: DaemonSessionSummary,
  source: SidebarSessionSource | undefined,
): boolean {
  if (source === 'channel') return session.sourceType === 'channel';
  if (source === 'default') {
    return session.sourceType === undefined || session.sourceType === 'default';
  }
  return true;
}

function getSessionIdentity(
  sessionId: string,
  workspaceCwd: string | undefined,
): string {
  return `${workspaceCwd ?? ''}\0${sessionId}`;
}

/** A catalog page the pin overlay drop check reads; undefined while the
 * query is disabled or unloaded. */
type PinCatalogPage = DaemonSessionSummary[] | undefined;

/** A pin toggle applied optimistically before the daemon RPC settles. */
interface OptimisticPinEntry {
  /** Session snapshot captured at toggle time, for rendering the row. */
  session: DaemonSessionSummary;
  pinned: boolean;
  /** Pin timestamp assigned optimistically (present when pinning). */
  pinnedAt?: string;
  rpcSettled: boolean;
}

function getPinnedSectionOrderTime(session: DaemonSessionSummary): number {
  const pinnedAt = Date.parse(session.pinnedAt ?? '');
  return Number.isFinite(pinnedAt) ? pinnedAt : 0;
}

// Pin order is stable: sessions sort by when they were pinned (new pins
// append at the bottom), never by last activity.
function comparePinnedSectionSessions(
  a: DaemonSessionSummary,
  b: DaemonSessionSummary,
): number {
  const byPinTime = getPinnedSectionOrderTime(a) - getPinnedSectionOrderTime(b);
  if (byPinTime !== 0) return byPinTime;
  return a.sessionId.localeCompare(b.sessionId);
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
  | 'channels'
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
  'channels',
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

type SessionWorkspaceScope =
  | { kind: 'primary'; cwd: string }
  | { kind: 'locked'; cwd: string; workspace: DaemonWorkspaceCapability }
  | { kind: 'restricted'; cwd: string; workspace: DaemonWorkspaceCapability }
  | { kind: 'untrusted'; cwd: string; workspace: DaemonWorkspaceCapability }
  | { kind: 'unknown'; cwd: string };

interface WebShellSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onOpenSettings: () => void;
  onOpenPlugins: () => void;
  onOpenChannels: () => void;
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
  onNewSession: (workspaceCwd?: string) => Promise<boolean> | boolean;
  onLoadSession: (
    sessionId: string,
    workspaceCwd?: string,
  ) => Promise<void> | void;
  onSelectCurrentSession?: () => void;
  onSessionRenameConfirmed?: (
    workspaceCwd: string,
    sessionId: string,
    displayName: string,
  ) => void;
  onSessionsDeleted?: (sessionIds: string[]) => void;
  onError: (error: unknown, fallback: string) => void;
  theme: WebShellTheme;
  onThemeChange: (theme: WebShellTheme) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
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
  onOpenCommit?: (workspaceCwd: string) => void;
  /**
   * Opens the shared App-owned Add Workspace dialog. Omit this callback when
   * registration is unavailable; locked workspaces hide the action separately.
   */
  onOpenAddWorkspace?: () => void;
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

// The cap scales with the window so wide displays can reveal full session
// names, but never exceeds half the window so the sidebar cannot crush the
// main content area. SIDEBAR_MAX_WIDTH is the floor, preserving the old
// fixed cap on small windows.
function getSidebarMaxWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_MAX_WIDTH;
  return Math.max(
    SIDEBAR_MAX_WIDTH,
    Math.floor(window.innerWidth * SIDEBAR_MAX_WIDTH_WINDOW_RATIO),
  );
}

function clampSidebarWidth(width: number): number {
  return Math.min(getSidebarMaxWidth(), Math.max(SIDEBAR_MIN_WIDTH, width));
}

function clampSidebarVisualWidth(width: number): number {
  return Math.min(
    getSidebarMaxWidth(),
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

function SessionMenu({
  onOpenChange,
  children,
}: {
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const openRef = useRef(false);
  useEffect(
    () => () => {
      // Radix emits no onOpenChange(false) when an open menu unmounts (its
      // row removed by a poll or preview slice); without the close signal the
      // collapsed surface's dismissal guards stay blocked forever.
      if (openRef.current) onOpenChange(false);
    },
    [onOpenChange],
  );
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        openRef.current = open;
        onOpenChange(open);
      }}
    >
      {children}
    </DropdownMenu>
  );
}

function SidebarSessionSurface({
  collapsed,
  label,
  status,
  statusLabel,
  width,
  open,
  onOpenChange,
  isCloseBlocked,
  children,
}: {
  collapsed: boolean;
  label: string;
  status?: 'approval' | 'question' | 'completed';
  statusLabel?: string;
  width: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCloseBlocked: () => boolean;
  children: ReactNode;
}) {
  const closeTimerRef = useRef<number | undefined>(undefined);
  const pointerOpenRef = useRef(false);
  const interactionOpenRef = useRef(false);
  const focusInsideSurfaceRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const changeOpen = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isCloseBlocked()) return;
      if (nextOpen && !open) focusInsideSurfaceRef.current = false;
      onOpenChange(nextOpen);
    },
    [isCloseBlocked, onOpenChange, open],
  );
  const cancelClose = useCallback(
    () => window.clearTimeout(closeTimerRef.current),
    [],
  );
  const closeAfterDelay = useCallback(() => {
    cancelClose();
    if (!pointerOpenRef.current) return;
    closeTimerRef.current = window.setTimeout(() => {
      // A hover-out must not unmount the surface while it holds keyboard
      // focus (search or rename inputs): the close would drop focus to body.
      // document.activeElement retargets to the shadow host in shadow-DOM
      // portal mode, so also probe the surface's own tree for :focus.
      if (
        contentRef.current?.contains(document.activeElement) ||
        contentRef.current?.querySelector(':focus')
      ) {
        return;
      }
      changeOpen(false);
    }, 150);
  }, [cancelClose, changeOpen]);

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  useEffect(() => {
    if (!collapsed || !open) return;
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerOpenRef.current) return;
      // Shadow-DOM portal mode retargets event.target to the shadow host;
      // composedPath keeps the real node (same approach as App.tsx).
      const target =
        (event.composedPath()[0] as Node | undefined) ?? event.target;
      const insideSurface =
        target instanceof Node &&
        (triggerRef.current?.contains(target) ||
          contentRef.current?.contains(target));
      const insideNestedOverlay =
        target instanceof Element &&
        target.closest(
          '[data-slot="dropdown-menu-content"], [data-slot="popover-content"]',
        );
      if (!insideSurface && !insideNestedOverlay) {
        closeAfterDelay();
      } else {
        cancelClose();
      }
    };
    document.addEventListener('pointermove', handlePointerMove);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      window.clearTimeout(closeTimerRef.current);
    };
  }, [cancelClose, closeAfterDelay, collapsed, open]);

  if (!collapsed) {
    return <div className={styles.sessionList}>{children}</div>;
  }

  return (
    <div className={styles.sessionList}>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            className={styles.pluginButton}
            type="button"
            aria-label={statusLabel ? `${label}: ${statusLabel}` : label}
            data-web-shell-collapsed-session-trigger
            onPointerEnter={() => {
              // Only an open initiated by the pointer uses hover semantics;
              // a graze over a keyboard-opened switcher must not suppress
              // focus restoration when it later closes.
              if (!open) pointerOpenRef.current = true;
              cancelClose();
              changeOpen(true);
            }}
            onPointerLeave={closeAfterDelay}
            onPointerDown={() => {
              if (!open) pointerOpenRef.current = true;
            }}
            onClick={(event) => {
              event.preventDefault();
              cancelClose();
              changeOpen(true);
            }}
            onKeyDown={() => {
              pointerOpenRef.current = false;
            }}
          >
            <span className={styles.navIcon}>
              <FolderClosedIcon size={16} strokeWidth={1.2} />
              {status && (
                <span
                  className={cx(
                    styles.collapsedSessionStatusDot,
                    status === 'approval' &&
                      styles.collapsedSessionStatusApproval,
                    status === 'question' &&
                      styles.collapsedSessionStatusQuestion,
                  )}
                  data-web-shell-collapsed-session-status={status}
                  aria-hidden="true"
                />
              )}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onFocus={() => {
            focusInsideSurfaceRef.current = true;
          }}
          className={styles.collapsedSessionPopover}
          style={
            {
              '--collapsed-session-popover-width': `${width}px`,
            } as CSSProperties
          }
          data-web-shell-collapsed-session-switcher
          onOpenAutoFocus={(event) => {
            if (pointerOpenRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            // Suppress Radix's focus restoration only while focus stayed
            // outside a pointer-opened surface; once focus has moved into
            // the content (search, rename), closing must return it to the
            // trigger like a keyboard-opened surface. Radix fires this
            // after the content unmounts, so the flag is tracked while the
            // surface is open instead of probed from document.activeElement.
            if (pointerOpenRef.current && !focusInsideSurfaceRef.current) {
              event.preventDefault();
            }
            pointerOpenRef.current = false;
            interactionOpenRef.current = false;
            focusInsideSurfaceRef.current = false;
          }}
          onEscapeKeyDown={() => {
            interactionOpenRef.current = false;
          }}
          onPointerEnter={cancelClose}
          onPointerLeave={closeAfterDelay}
          onPointerDownCapture={() => {
            interactionOpenRef.current = true;
            cancelClose();
          }}
          onInteractOutside={(event) => {
            const originalEvent = event.detail.originalEvent;
            const originalTarget = originalEvent.composedPath()[0];
            const target = (originalTarget as Node | undefined) ?? event.target;
            if (
              target instanceof Element &&
              target.closest(
                '[data-slot="dropdown-menu-content"], [data-slot="popover-content"]',
              )
            ) {
              event.preventDefault();
            } else if (
              interactionOpenRef.current &&
              originalEvent.type === 'focusin'
            ) {
              event.preventDefault();
            } else {
              interactionOpenRef.current = false;
            }
          }}
        >
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function WebShellSidebar({
  collapsed,
  onCollapsedChange,
  onOpenSettings,
  onOpenPlugins,
  onOpenChannels,
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
  onSessionRenameConfirmed,
  onSessionsDeleted,
  onError,
  theme,
  onThemeChange,
  mobileOpen,
  onMobileClose,
  selectedWorkspaceCwd,
  onSelectWorkspace,
  onOpenGitDiff,
  onOpenCommit,
  onOpenAddWorkspace,
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
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  const footerItems = useMemo(
    () =>
      new Set(footer === false ? [] : (footer?.items ?? DEFAULT_FOOTER_ITEMS)),
    [footer],
  );
  const primaryNavItems = useMemo(
    () => new Set(primaryNavOptions?.items ?? DEFAULT_PRIMARY_NAV_ITEMS),
    [primaryNavOptions?.items],
  );
  const hasScrollingPrimaryNav =
    primaryNavItems.has('plugins') ||
    primaryNavItems.has('channels') ||
    primaryNavItems.has('scheduledTasks') ||
    primaryNavItems.has('goals') ||
    Boolean(primaryNavOptions?.render);
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
  const sourceMetadataEnabled = Boolean(
    connection.capabilities?.features?.includes('session_source_metadata'),
  );
  const [sessionSource, setSessionSource] =
    useState<SidebarSessionSource>('default');
  const selectedSessionSource = sourceMetadataEnabled
    ? sessionSource
    : undefined;
  const channelGroupingEnabled = Boolean(
    selectedSessionSource === 'channel' &&
      workspace.capabilities?.features.includes('channel_management'),
  );
  const {
    data: channelCatalogData,
    catalog: channelTypeCatalog,
    channels: channelInstances,
    reload: reloadChannelCatalog,
    error: channelCatalogError,
  } = useChannels({
    autoLoad: channelGroupingEnabled,
    enabled: channelGroupingEnabled,
  });
  const sessionArchiveEnabled = Boolean(
    connection.capabilities?.features?.includes('session_archive'),
  );
  const workspaceQualifiedRestCoreEnabled = Boolean(
    connection.capabilities?.features?.includes(
      'workspace_qualified_rest_core',
    ),
  );
  const workspaceSessionLiveStateSupported = Boolean(
    connection.capabilities?.features?.includes(
      'workspace_session_live_state',
    ) && typeof workspace.client.getWorkspaceSessionLiveState === 'function',
  );
  const sessionCatalogRequestsEnabled = connection.capabilities !== undefined;
  const workspaceSessionMetadataEnabled = Boolean(
    connection.capabilities?.features?.includes('workspace_session_metadata'),
  );
  // Phase 4: registered workspaces on a multi-workspace daemon (absent or a
  // single entry otherwise). Drives the new-session workspace picker.
  const workspaces = useMemo(
    () => providedWorkspaces ?? workspace.capabilities?.workspaces ?? [],
    [providedWorkspaces, workspace.capabilities?.workspaces],
  );
  const workspaceCatalogAdvertised =
    workspaces.length > 0 ||
    workspace.capabilities?.workspaces !== undefined ||
    connection.capabilities?.workspaces !== undefined;
  const primaryWorkspaceCwd =
    workspaces.find((entry) => entry.primary)?.cwd ??
    workspace.capabilities?.workspaceCwd ??
    connection.workspaceCwd;
  const primaryWorkspaceExpansionId = `primary:${
    primaryWorkspaceCwd ?? 'default'
  }`;
  const lockedWorkspace = lockedWorkspaceCwd
    ? workspaces.find((entry) => entry.cwd === lockedWorkspaceCwd)
    : undefined;
  const includePrimaryWorkspaceSessions =
    !lockedWorkspaceCwd || lockedWorkspace?.primary === true;
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
  const liveStateWorkspaceCwds = useMemo(
    () =>
      displayedWorkspaces
        .filter((entry) => entry.trusted && isAbsolutePath(entry.cwd))
        .map((entry) => entry.cwd),
    [displayedWorkspaces],
  );
  const liveStateWorkspaceCwdSet = useMemo(
    () => new Set(liveStateWorkspaceCwds),
    [liveStateWorkspaceCwds],
  );
  const liveStateGroupWorkspaceCwds = useMemo(
    () =>
      organizationEnabled && !channelGroupingEnabled
        ? displayedWorkspaces
            .filter(
              (entry) =>
                entry.kind !== 'live' &&
                entry.trusted &&
                isAbsolutePath(entry.cwd),
            )
            .map((entry) => entry.cwd)
        : [],
    [channelGroupingEnabled, displayedWorkspaces, organizationEnabled],
  );
  const workspaceSessionLiveStateEnabled =
    workspaceSessionLiveStateSupported && liveStateWorkspaceCwds.length > 0;
  const primaryWorkspaceSessionLiveStateEnabled = Boolean(
    workspaceSessionLiveStateEnabled &&
      primaryWorkspaceCwd &&
      liveStateWorkspaceCwdSet.has(primaryWorkspaceCwd),
  );
  const primaryWorkspaceLiveStateGroupsEnabled = Boolean(
    primaryWorkspaceSessionLiveStateEnabled &&
      primaryWorkspaceCwd &&
      liveStateGroupWorkspaceCwds.includes(primaryWorkspaceCwd),
  );
  const secondaryWorkspaceCwds = useMemo(
    () =>
      displayedWorkspaces
        .filter((entry) => !entry.primary && entry.trusted)
        .map((entry) => entry.cwd),
    [displayedWorkspaces],
  );
  const secondaryWorkspaceSessionLiveStateEnabled =
    workspaceSessionLiveStateEnabled &&
    secondaryWorkspaceCwds.length > 0 &&
    secondaryWorkspaceCwds.every((cwd) => liveStateWorkspaceCwdSet.has(cwd));
  const {
    sessions,
    loading,
    error,
    data: sessionsPage,
    reload,
    deleteSession,
    exportSession,
    archiveSession,
    catalogQuery,
  } = useWebShellSessions({
    autoLoad:
      sessionCatalogRequestsEnabled && !primaryWorkspaceSessionLiveStateEnabled,
    enabled: includePrimaryWorkspaceSessions,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(selectedSessionSource ? { sourceType: selectedSessionSource } : {}),
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  // The catalog starts with loading=false before its subscription requests
  // data, so !loading is not “settled”. Treat the first data as the ready signal (empty
  // lists are still defined data) so the initial-catalog latch waits. Errors
  // must NOT settle it: a latch consumed against a failed request would treat
  // every section from the eventual successful reload as brand-new,
  // auto-collapsing and persisting over the user's restored expansions.
  const sessionsCatalogReady =
    !organizationEnabled ||
    !includePrimaryWorkspaceSessions ||
    sessionsPage !== undefined;
  // Which source the settled sessions page belongs to. Switching the source
  // changes the catalog query key, whose entry starts without a page
  // (undefined), so reconciliation must not run until a page fetched for the
  // new source settles — otherwise the other source's sections would be
  // consumed as the new source's initial catalog.
  const lastSettledSessionsPageRef = useRef(sessionsPage);
  const settledSessionsSourceRef = useRef<SidebarSessionSource>(sessionSource);
  useEffect(() => {
    // An undefined page is the empty pre-settle snapshot, not a settled fetch.
    if (sessionsPage === undefined) return;
    if (lastSettledSessionsPageRef.current !== sessionsPage) {
      lastSettledSessionsPageRef.current = sessionsPage;
      settledSessionsSourceRef.current = sessionSource;
    }
  }, [sessionsPage, sessionSource]);
  const loadPinnedSessions =
    organizationEnabled && selectedSessionSource !== 'channel';
  const { sessions: primaryPinnedSessions, data: primaryPinnedSessionsPage } =
    useWebShellSessions({
      autoLoad:
        sessionCatalogRequestsEnabled &&
        loadPinnedSessions &&
        !primaryWorkspaceSessionLiveStateEnabled,
      enabled: loadPinnedSessions && includePrimaryWorkspaceSessions,
      pageSize: SESSION_LIST_PAGE_SIZE,
      archiveState: 'active',
      ...(selectedSessionSource ? { sourceType: selectedSessionSource } : {}),
      view: 'organized',
      group: 'pinned',
    });
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  // Pin toggles applied optimistically while the daemon organization RPC is
  // in flight. The catalog store mirrors each toggle into its loaded pages
  // (applySessionPinToggle); these entries only render rows no loaded page
  // carries yet, and are dropped once one does or rolled back on RPC failure.
  const [optimisticPins, setOptimisticPins] = useState<
    ReadonlyMap<string, OptimisticPinEntry>
  >(() => new Map());
  const {
    sessions: archivedSessions,
    loading: archivedLoading,
    error: archivedError,
    reload: reloadArchived,
    deleteSession: deleteArchivedSession,
    unarchiveSession,
    catalogQuery: archivedCatalogQuery,
  } = useWebShellSessions({
    autoLoad:
      sessionCatalogRequestsEnabled && !primaryWorkspaceSessionLiveStateEnabled,
    enabled:
      sessionArchiveEnabled &&
      archivedExpanded &&
      includePrimaryWorkspaceSessions,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'archived',
    ...(selectedSessionSource ? { sourceType: selectedSessionSource } : {}),
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [menuGroups, setMenuGroups] = useState<DaemonSessionGroup[]>([]);
  const [colorOptions, setColorOptions] = useState<
    DaemonSessionGroupPresetColor[]
  >([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [editingSessionIdentity, setEditingSessionIdentity] = useState<
    string | null
  >(null);
  const [editingSession, setEditingSession] =
    useState<DaemonSessionSummary | null>(null);
  const [editingName, setEditingName] = useState('');
  // Mirrors editingSessionIdentity for promise callbacks that outlive the
  // render where the rename started.
  const editingSessionIdentityRef = useRef<string | null>(null);
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
  const groupMenuOpenRef = useRef(groupMenu !== null);
  useEffect(() => {
    groupMenuOpenRef.current = groupMenu !== null;
  }, [groupMenu]);
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
  // Dedicated first-sync latch, keyed by session source: each source's first
  // settled catalog only registers section ids. Without per-source latches the
  // Tasks settle consumes the shared latch and the first Channels visit treats
  // every platform section as brand-new, auto-collapsing and persisting them.
  // Do not infer this from knownSessionSectionIdsRef.size — seeding that set
  // early would make the first real sync look mid-session and auto-collapse
  // restored expansions.
  const awaitingInitialSessionCatalogBySourceRef = useRef<
    Record<SidebarSessionSource, boolean>
  >({ default: true, channel: true });
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
  const [projectExpanded, setProjectExpanded] = useState(() =>
    readWorkspaceExpanded(primaryWorkspaceExpansionId),
  );
  const [showAllProjectSessions, setShowAllProjectSessions] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(
    () => hideProjectHeader || readWorkspaceExpanded('projects'),
  );
  const [collapsedSessionsOpen, setCollapsedSessionsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bodyScrolled, setBodyScrolled] = useState(false);
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
  // Keep the token for WorkspaceSection's group and Git consumers. Session
  // catalogs are invalidated directly through their owning workspace.
  const bumpWorkspaceReload = useCallback(() => {
    setWorkspaceSessionsReloadToken((v) => v + 1);
  }, []);

  useEffect(() => {
    // The five-row preview is scoped per source and per primary workspace;
    // reset the one-shot show-all when either changes, not only on collapse.
    setShowAllProjectSessions(false);
  }, [projectExpanded, primaryWorkspaceExpansionId, selectedSessionSource]);

  const previousPrimaryExpansionIdRef = useRef(primaryWorkspaceExpansionId);
  useEffect(() => {
    const previousId = previousPrimaryExpansionIdRef.current;
    previousPrimaryExpansionIdRef.current = primaryWorkspaceExpansionId;
    if (previousId !== primaryWorkspaceExpansionId) {
      migrateWorkspaceExpansionPreference(
        previousId,
        primaryWorkspaceExpansionId,
      );
    }
    setProjectExpanded(readWorkspaceExpanded(primaryWorkspaceExpansionId));
  }, [primaryWorkspaceExpansionId]);

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
  const sidebarRef = useRef<HTMLElement>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const sessionMenuPointerDismissRef = useRef(false);
  const sessionMenuOpenRef = useRef(false);
  const renameFocusSuppressRef = useRef(false);
  const handleSessionMenuOpenChange = useCallback((open: boolean) => {
    sessionMenuOpenRef.current = open;
    if (open) renameFocusSuppressRef.current = false;
  }, []);
  const handleSessionMenuPointerDownOutside = useCallback(() => {
    sessionMenuPointerDismissRef.current = true;
  }, []);
  const handleSessionMenuCloseAutoFocus = useCallback((event: Event) => {
    if (renameFocusSuppressRef.current) {
      renameFocusSuppressRef.current = false;
      event.preventDefault();
      return;
    }
    if (!sessionMenuPointerDismissRef.current) return;
    sessionMenuPointerDismissRef.current = false;
    event.preventDefault();
  }, []);
  const isCollapsedCloseBlocked = useCallback(
    () =>
      sessionMenuOpenRef.current ||
      groupMenu !== null ||
      deleteCandidate !== null,
    [deleteCandidate, groupMenu],
  );
  const previousRunningBySourceRef = useRef<
    Record<SidebarSessionSource, Map<string, boolean> | null>
  >({ default: null, channel: null });
  const previousSecondaryRunningBySourceRef = useRef<
    Record<SidebarSessionSource, Map<string, boolean> | null>
  >({ default: null, channel: null });
  const lastTrackedSessionSourceRef = useRef(sessionSource);
  const autoOpenedContextRef = useRef<string | null>(null);
  const resizeTeardownRef = useRef<((updateState: boolean) => void) | null>(
    null,
  );
  const currentSessionId = connection.sessionId;
  const workspaceRemovalEnabled = Boolean(
    connection.capabilities?.features?.includes('workspace_runtime_removal'),
  );
  const canExportSessions =
    connection.capabilities?.features?.includes('session_export') ?? false;
  const canExportWorkspaceSessions =
    connection.capabilities?.features?.includes('workspace_session_export') ??
    false;
  const canExportArchivedSessions =
    connection.capabilities?.features?.includes(
      'workspace_archived_session_export',
    ) ?? false;
  const currentSessionIdentity = currentSessionId
    ? getSessionIdentity(
        currentSessionId,
        connection.workspaceCwd || primaryWorkspaceCwd,
      )
    : null;
  const liveStateGroupCatalogs = useWorkspaceSessionLiveState(
    workspace.client,
    {
      enabled: workspaceSessionLiveStateEnabled,
      workspaceCwds: liveStateWorkspaceCwds,
      groupWorkspaceCwds: liveStateGroupWorkspaceCwds,
    },
  );
  const primaryLiveStateGroupCatalog = primaryWorkspaceCwd
    ? liveStateGroupCatalogs.get(primaryWorkspaceCwd)
    : undefined;
  const secondaryActiveQueries = useMemo<SessionCatalogQuery[]>(
    () =>
      secondaryWorkspaceCwds.map((workspaceCwd) => ({
        routeKind: 'qualified',
        workspaceCwd,
        options: {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
          ...(selectedSessionSource
            ? { sourceType: selectedSessionSource }
            : {}),
          ...(organizationEnabled
            ? { view: 'organized' as const, group: 'all' }
            : {}),
        },
      })),
    [organizationEnabled, secondaryWorkspaceCwds, selectedSessionSource],
  );
  const secondaryActiveSnapshots = useSessionCatalogQueries(
    workspace.client,
    secondaryActiveQueries,
    {
      autoLoad:
        sessionCatalogRequestsEnabled &&
        collapsed &&
        !secondaryWorkspaceSessionLiveStateEnabled,
      pollIntervalMs:
        sessionCatalogRequestsEnabled &&
        collapsed &&
        !secondaryWorkspaceSessionLiveStateEnabled
          ? ACTIVE_SESSION_POLL_INTERVAL_MS
          : undefined,
    },
  );
  const secondaryActiveSessions = useMemo(
    () =>
      secondaryActiveSnapshots.flatMap(
        (snapshot) => snapshot.page?.sessions ?? [],
      ),
    [secondaryActiveSnapshots],
  );
  const secondaryPinnedQueries = useMemo<SessionCatalogQuery[]>(
    () =>
      secondaryWorkspaceCwds.map((workspaceCwd) => ({
        routeKind: 'qualified',
        workspaceCwd,
        options: {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
          ...(selectedSessionSource
            ? { sourceType: selectedSessionSource }
            : {}),
          view: 'organized',
          group: 'pinned',
        },
      })),
    [secondaryWorkspaceCwds, selectedSessionSource],
  );
  const secondaryPinnedSnapshots = useSessionCatalogQueries(
    workspace.client,
    secondaryPinnedQueries,
    {
      autoLoad:
        sessionCatalogRequestsEnabled &&
        !secondaryWorkspaceSessionLiveStateEnabled,
      enabled: organizationEnabled && selectedSessionSource !== 'channel',
    },
  );
  const secondaryPinnedSessions = useMemo(
    () =>
      secondaryPinnedSnapshots.flatMap(
        (snapshot) => snapshot.page?.sessions ?? [],
      ),
    [secondaryPinnedSnapshots],
  );
  // Every catalog page the sidebar renders pin state from. The pin overlay
  // drop check only asks whether a loaded page carries the toggled row —
  // never which page reference a refresh minted — so churn that recreates
  // pages without touching pin state cannot be mistaken for a refresh.
  const pinCatalogPages = useMemo<PinCatalogPage[]>(() => {
    const pages: PinCatalogPage[] = [];
    if (includePrimaryWorkspaceSessions) {
      pages.push(primaryPinnedSessionsPage);
    }
    for (const snapshot of secondaryPinnedSnapshots) {
      pages.push(snapshot.page?.sessions);
    }
    pages.push(sessionsPage);
    for (const snapshot of secondaryActiveSnapshots) {
      pages.push(snapshot.page?.sessions);
    }
    return pages;
  }, [
    includePrimaryWorkspaceSessions,
    primaryPinnedSessionsPage,
    secondaryActiveSnapshots,
    secondaryPinnedSnapshots,
    sessionsPage,
  ]);
  const secondaryArchivedEnabled =
    archivedExpanded &&
    sessionArchiveEnabled &&
    workspaceQualifiedRestCoreEnabled;
  const secondaryArchivedQueries = useMemo<SessionCatalogQuery[]>(
    () =>
      secondaryWorkspaceCwds.map((workspaceCwd) => ({
        routeKind: 'qualified',
        workspaceCwd,
        options: {
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'archived',
          ...(selectedSessionSource
            ? { sourceType: selectedSessionSource }
            : {}),
          ...(organizationEnabled
            ? { view: 'organized' as const, group: 'all' }
            : {}),
        },
      })),
    [organizationEnabled, secondaryWorkspaceCwds, selectedSessionSource],
  );
  const secondaryArchivedSnapshots = useSessionCatalogQueries(
    workspace.client,
    secondaryArchivedQueries,
    {
      autoLoad:
        sessionCatalogRequestsEnabled &&
        !secondaryWorkspaceSessionLiveStateEnabled,
      enabled: secondaryArchivedEnabled,
    },
  );
  const secondaryArchivedSessions = useMemo(
    () =>
      secondaryArchivedSnapshots.flatMap(
        (snapshot) => snapshot.page?.sessions ?? [],
      ),
    [secondaryArchivedSnapshots],
  );
  const secondaryArchivedLoading = secondaryArchivedSnapshots.some(
    (snapshot) => snapshot.loading,
  );
  const secondaryArchivedError = secondaryArchivedSnapshots.some(
    (snapshot) => snapshot.error !== undefined,
  );
  const toggleArchived = useCallback(() => {
    if (!archivedExpanded) {
      const queries = [
        ...(includePrimaryWorkspaceSessions && archivedCatalogQuery
          ? [archivedCatalogQuery]
          : []),
        ...(workspaceQualifiedRestCoreEnabled ? secondaryArchivedQueries : []),
      ];
      if (queries.length > 0) {
        sessionCatalogController.refreshQueries(queries);
      }
    }
    setArchivedExpanded((expanded) => !expanded);
  }, [
    archivedCatalogQuery,
    archivedExpanded,
    includePrimaryWorkspaceSessions,
    secondaryArchivedQueries,
    sessionCatalogController,
    workspaceQualifiedRestCoreEnabled,
  ]);
  const liveWorkspaces = useMemo(
    () => displayedWorkspaces.filter((entry) => entry.kind === 'live'),
    [displayedWorkspaces],
  );
  const projectWorkspaces = useMemo(
    () => displayedWorkspaces.filter((entry) => entry.kind !== 'live'),
    [displayedWorkspaces],
  );
  const resolveSessionWorkspaceScope = useCallback(
    (session: DaemonSessionSummary): SessionWorkspaceScope => {
      const explicitCwd = session.workspaceCwd;
      const cwd = explicitCwd || primaryWorkspaceCwd || '';
      const workspaceEntry = workspaces.find((entry) => entry.cwd === cwd);

      if (explicitCwd && !workspaceEntry) {
        if (!workspaceCatalogAdvertised && cwd === primaryWorkspaceCwd) {
          return { kind: 'primary', cwd };
        }
        return { kind: 'unknown', cwd };
      }
      if (workspaceEntry && !workspaceEntry.trusted) {
        return { kind: 'untrusted', cwd, workspace: workspaceEntry };
      }
      if (
        workspaceEntry?.primary ||
        (!explicitCwd && cwd === primaryWorkspaceCwd)
      ) {
        return { kind: 'primary', cwd };
      }
      if (!workspaceEntry) return { kind: 'unknown', cwd };
      if (lockedWorkspaceCwd === cwd) {
        return { kind: 'locked', cwd, workspace: workspaceEntry };
      }
      return { kind: 'restricted', cwd, workspace: workspaceEntry };
    },
    [
      lockedWorkspaceCwd,
      primaryWorkspaceCwd,
      workspaceCatalogAdvertised,
      workspaces,
    ],
  );
  const getSessionWorkspaceCwd = useCallback(
    (session: DaemonSessionSummary) =>
      resolveSessionWorkspaceScope(session).cwd,
    [resolveSessionWorkspaceScope],
  );
  const isMutableSessionScope = useCallback(
    (scope: SessionWorkspaceScope) =>
      scope.kind === 'primary' || scope.kind === 'locked',
    [],
  );
  const canUseWorkspaceQualifiedActions = useCallback(
    (scope: SessionWorkspaceScope) =>
      scope.kind === 'primary' ||
      ((scope.kind === 'locked' || scope.kind === 'restricted') &&
        workspaceQualifiedRestCoreEnabled),
    [workspaceQualifiedRestCoreEnabled],
  );
  // Organization (pin/group) is safe for any trusted workspace — not just
  // locked ones — because it only mutates display metadata, never executes
  // code or touches the filesystem.
  const canUseOrganizationActions = useCallback(
    (scope: SessionWorkspaceScope) => {
      if (scope.kind === 'unknown' || scope.kind === 'untrusted') return false;
      return scope.kind === 'primary' || workspaceQualifiedRestCoreEnabled;
    },
    [workspaceQualifiedRestCoreEnabled],
  );
  const getSessionWorkspaceActions = useCallback(
    (session: DaemonSessionSummary) => {
      const scope = resolveSessionWorkspaceScope(session);
      if (scope.kind === 'primary') return workspaceActions;
      if (scope.kind === 'locked' || scope.kind === 'restricted') {
        return workspace.client.workspaceByCwd(scope.cwd);
      }
      return undefined;
    },
    [resolveSessionWorkspaceScope, workspace.client, workspaceActions],
  );
  const getIdentityForSession = useCallback(
    (session: DaemonSessionSummary) =>
      getSessionIdentity(session.sessionId, getSessionWorkspaceCwd(session)),
    [getSessionWorkspaceCwd],
  );
  const applyOptimisticPin = useCallback(
    (session: DaemonSessionSummary): DaemonSessionSummary => {
      if (optimisticPins.size === 0) return session;
      const entry = optimisticPins.get(getIdentityForSession(session));
      if (!entry || entry.pinned === (session.isPinned === true)) {
        return session;
      }
      const next: DaemonSessionSummary = {
        ...session,
        isPinned: entry.pinned,
      };
      if (entry.pinned) {
        if (entry.pinnedAt !== undefined) next.pinnedAt = entry.pinnedAt;
      } else {
        delete next.pinnedAt;
      }
      return next;
    },
    [optimisticPins, getIdentityForSession],
  );
  // Drop a settled overlay entry once any loaded page carries its row. The
  // store owns the optimistic pin state in the pages themselves
  // (applySessionPinToggle), so a carried row is correct whether the page
  // holds the store-applied toggle or an authoritative refetch — either way
  // the overlay has nothing left to contribute. Carriage is a pin-state
  // question, and churn (patchSession, live-state ticks) recreates page
  // references without touching pin state, so churn can neither drop an
  // entry early nor strand one: the R5-1 entrances keyed on page-reference
  // freshness no longer exist. An entry whose row no loaded page carries
  // stays until it does (or the RPC fails), rendering the row from its
  // snapshot in the pinned section meanwhile.
  useEffect(() => {
    if (optimisticPins.size === 0) return;
    const staleIdentities: string[] = [];
    for (const [identity, entry] of optimisticPins) {
      if (!entry.rpcSettled) continue;
      const carried = pinCatalogPages.some((page) =>
        page?.some(
          (candidate) => getIdentityForSession(candidate) === identity,
        ),
      );
      if (carried) staleIdentities.push(identity);
    }
    if (staleIdentities.length === 0) return;
    setOptimisticPins((previous) => {
      const next = new Map(previous);
      for (const identity of staleIdentities) next.delete(identity);
      return next;
    });
  }, [getIdentityForSession, optimisticPins, pinCatalogPages]);
  const pinnedSessions = useMemo(() => {
    const byId = new Map<string, DaemonSessionSummary>();
    const addCandidate = (
      session: DaemonSessionSummary,
      options: { requirePinned: boolean },
    ): void => {
      if (!matchesSessionSource(session, selectedSessionSource)) return;
      // Rows fetched through the pinned filter stay unless an optimistic
      // unpin flips them; rows merged from other pages must be pinned.
      if (session.isPinned === false) return;
      if (options.requirePinned && session.isPinned !== true) return;
      byId.set(getIdentityForSession(session), session);
    };
    for (const rawSession of [
      ...(includePrimaryWorkspaceSessions ? primaryPinnedSessions : []),
      ...secondaryPinnedSessions,
    ]) {
      addCandidate(applyOptimisticPin(rawSession), { requirePinned: false });
    }
    // The all-sessions page carries optimistic pins before the pinned page
    // refetch lands.
    for (const rawSession of sessions) {
      addCandidate(applyOptimisticPin(rawSession), { requirePinned: true });
    }
    // A row pinned from a workspace section that no loaded page carries yet
    // renders from its optimistic snapshot so the pin still feels instant.
    for (const [identity, entry] of optimisticPins) {
      if (!entry.pinned || byId.has(identity)) continue;
      addCandidate(applyOptimisticPin(entry.session), { requirePinned: true });
    }
    return [...byId.values()].sort(comparePinnedSectionSessions);
  }, [
    applyOptimisticPin,
    getIdentityForSession,
    includePrimaryWorkspaceSessions,
    optimisticPins,
    primaryPinnedSessions,
    selectedSessionSource,
    secondaryPinnedSessions,
    sessions,
  ]);
  const isCurrentSession = useCallback(
    (session: DaemonSessionSummary) =>
      currentSessionIdentity === getIdentityForSession(session),
    [currentSessionIdentity, getIdentityForSession],
  );
  const canRenameSession = useCallback(
    (session: DaemonSessionSummary) => {
      if (!sessionActionItems.has('rename')) return false;
      const scope = resolveSessionWorkspaceScope(session);
      if (isCurrentSession(session) && isMutableSessionScope(scope)) {
        return true;
      }
      return (
        workspaceSessionMetadataEnabled &&
        canUseWorkspaceQualifiedActions(scope)
      );
    },
    [
      canUseWorkspaceQualifiedActions,
      isCurrentSession,
      isMutableSessionScope,
      resolveSessionWorkspaceScope,
      sessionActionItems,
      workspaceSessionMetadataEnabled,
    ],
  );
  const canShowDeleteSession = useCallback(
    (session: DaemonSessionSummary) =>
      sessionActionItems.has('delete') &&
      canUseWorkspaceQualifiedActions(resolveSessionWorkspaceScope(session)),
    [
      canUseWorkspaceQualifiedActions,
      resolveSessionWorkspaceScope,
      sessionActionItems,
    ],
  );
  const canDeleteSession = useCallback(
    (session: DaemonSessionSummary) =>
      !isCurrentSession(session) && canShowDeleteSession(session),
    [canShowDeleteSession, isCurrentSession],
  );
  const canOrganizeSession = useCallback(
    (session: DaemonSessionSummary, item: 'pin' | 'group') =>
      organizationEnabled &&
      sessionActionItems.has(item) &&
      canUseOrganizationActions(resolveSessionWorkspaceScope(session)),
    [
      canUseOrganizationActions,
      organizationEnabled,
      resolveSessionWorkspaceScope,
      sessionActionItems,
    ],
  );
  const resolveWorkspaceScope = useCallback(
    (workspaceCwd?: string) =>
      resolveSessionWorkspaceScope({
        sessionId: '',
        workspaceCwd,
      } as DaemonSessionSummary),
    [resolveSessionWorkspaceScope],
  );
  const canOrganizeWorkspace = useCallback(
    (workspaceCwd?: string) =>
      organizationEnabled &&
      sessionActionItems.has('group') &&
      canUseOrganizationActions(resolveWorkspaceScope(workspaceCwd)),
    [
      canUseOrganizationActions,
      organizationEnabled,
      resolveWorkspaceScope,
      sessionActionItems,
    ],
  );
  const groupAssignmentPolicyRef = useRef<{
    canOrganizeSession: typeof canOrganizeSession;
    getSessionWorkspaceActions: typeof getSessionWorkspaceActions;
    resolveWorkspaceScope: typeof resolveWorkspaceScope;
  } | null>(null);
  groupAssignmentPolicyRef.current = {
    canOrganizeSession,
    getSessionWorkspaceActions,
    resolveWorkspaceScope,
  };
  const canMutateSessionArchive = useCallback(
    (session: DaemonSessionSummary) => {
      const scope = resolveSessionWorkspaceScope(session);
      if (scope.kind === 'unknown' || scope.kind === 'untrusted') return false;
      return (
        sessionArchiveEnabled &&
        (scope.kind === 'primary' || workspaceQualifiedRestCoreEnabled)
      );
    },
    [
      resolveSessionWorkspaceScope,
      sessionArchiveEnabled,
      workspaceQualifiedRestCoreEnabled,
    ],
  );
  const getActiveExportScope = useCallback(
    (session: DaemonSessionSummary) => {
      const scope = resolveSessionWorkspaceScope(session);
      if (scope.kind === 'primary' && canExportSessions) {
        return scope;
      }
      if (scope.kind === 'locked' && canExportWorkspaceSessions) {
        return scope;
      }
      return undefined;
    },
    [
      canExportSessions,
      canExportWorkspaceSessions,
      resolveSessionWorkspaceScope,
    ],
  );
  const getArchivedExportWorkspaceCwd = useCallback(
    (session: DaemonSessionSummary) => {
      const scope = resolveSessionWorkspaceScope(session);
      return canExportArchivedSessions &&
        scope.kind !== 'unknown' &&
        scope.kind !== 'untrusted'
        ? scope.cwd
        : undefined;
    },
    [canExportArchivedSessions, resolveSessionWorkspaceScope],
  );
  const canArchiveSession = useCallback(
    (session: DaemonSessionSummary) =>
      sessionActionItems.has('archive') &&
      !isCurrentSession(session) &&
      canMutateSessionArchive(session),
    [canMutateSessionArchive, isCurrentSession, sessionActionItems],
  );
  const canUnarchiveSession = useCallback(
    (session: DaemonSessionSummary) =>
      sessionActionItems.has('archive') && canMutateSessionArchive(session),
    [canMutateSessionArchive, sessionActionItems],
  );

  const allArchivedSessions = useMemo(() => {
    const byIdentity = new Map<string, DaemonSessionSummary>();
    for (const session of [
      ...(includePrimaryWorkspaceSessions ? archivedSessions : []),
      ...secondaryArchivedSessions,
    ]) {
      if (!matchesSessionSource(session, selectedSessionSource)) continue;
      byIdentity.set(getIdentityForSession(session), session);
    }
    return [...byIdentity.values()];
  }, [
    archivedSessions,
    getIdentityForSession,
    includePrimaryWorkspaceSessions,
    selectedSessionSource,
    secondaryArchivedSessions,
  ]);
  const effectiveArchivedLoading =
    (includePrimaryWorkspaceSessions && archivedLoading) ||
    secondaryArchivedLoading;
  const effectiveArchivedError =
    (includePrimaryWorkspaceSessions && Boolean(archivedError)) ||
    secondaryArchivedError;

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
    '--web-shell-sidebar-min-width': `${SIDEBAR_MIN_WIDTH}px`,
    '--web-shell-sidebar-max-width': `${getSidebarMaxWidth()}px`,
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
    if (!hasWorkspaceExpansionPreference('projects')) {
      setProjectsExpanded(true);
    }
    if (activeWorkspace.primary) {
      if (!hasWorkspaceExpansionPreference(primaryWorkspaceExpansionId)) {
        setProjectExpanded(true);
      }
    } else if (!hasWorkspaceExpansionPreference(activeWorkspace.id)) {
      setAutoExpandWorkspace({ id: activeWorkspace.id, key: contextKey });
    }
  }, [
    connection.workspaceCwd,
    currentSessionId,
    displayedWorkspaces,
    primaryWorkspaceExpansionId,
  ]);

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
    if (!hasWorkspaceExpansionPreference('projects')) {
      setProjectsExpanded(true);
    }
    if (connectedWorkspace && !connectedWorkspace.primary) {
      if (!hasWorkspaceExpansionPreference(connectedWorkspace.id)) {
        setAutoExpandWorkspace({
          id: connectedWorkspace.id,
          key: contextKey,
        });
      }
      onSelectWorkspace?.(connectedWorkspace.cwd);
      return;
    }
    if (!hasWorkspaceExpansionPreference(primaryWorkspaceExpansionId)) {
      setProjectExpanded(true);
    }
  }, [
    connection.workspaceCwd,
    currentSessionId,
    onSelectWorkspace,
    primaryWorkspaceExpansionId,
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
    if (!organizationEnabled || channelGroupingEnabled) {
      setGroups([]);
      setMenuGroups([]);
      setColorOptions([]);
      setGroupsCatalogReady(true);
      return;
    }
    if (primaryWorkspaceLiveStateGroupsEnabled) return;
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
  }, [
    channelGroupingEnabled,
    onError,
    organizationEnabled,
    primaryWorkspaceLiveStateGroupsEnabled,
    t,
    workspaceActions,
  ]);

  useEffect(() => {
    if (!organizationEnabled || channelGroupingEnabled) {
      setGroups([]);
      setMenuGroups([]);
      setColorOptions([]);
      setGroupsCatalogReady(true);
      return;
    }
    if (!includePrimaryWorkspaceSessions) {
      setGroups([]);
      setMenuGroups([]);
      setColorOptions([]);
      setGroupsCatalogReady(true);
      return;
    }
    if (primaryWorkspaceLiveStateGroupsEnabled) {
      setGroupsCatalogReady(false);
      if (!primaryLiveStateGroupCatalog) return;
      setGroups(primaryLiveStateGroupCatalog.groups);
      // The open group menu may be anchored to a session from a different
      // workspace (openGroupMenuFromAnchor loads menuGroups from the
      // session's own workspace) — don't clobber it with the primary
      // workspace's catalog on every reconcile.
      if (!groupMenuOpenRef.current) {
        setMenuGroups(primaryLiveStateGroupCatalog.groups);
        setColorOptions(primaryLiveStateGroupCatalog.colorOptions);
      }
      setGroupsCatalogReady(true);
      return;
    }
    setGroupsCatalogReady(false);
    void reloadGroups();
  }, [
    includePrimaryWorkspaceSessions,
    channelGroupingEnabled,
    organizationEnabled,
    primaryLiveStateGroupCatalog,
    reloadGroups,
    primaryWorkspaceLiveStateGroupsEnabled,
  ]);

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

  // The max width derives from window size, so re-clamp when the window
  // shrinks below a previously stored wider sidebar.
  useEffect(() => {
    function handleWindowResize() {
      setSidebarWidth((current) => clampSidebarWidth(current));
    }
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const hasRunningSession = useMemo(
    () => sessions.some((session) => session.hasActivePrompt),
    [sessions],
  );
  const statusSessions = useMemo(() => {
    const byIdentity = new Map<string, DaemonSessionSummary>();
    for (const session of [...sessions, ...secondaryActiveSessions]) {
      byIdentity.set(getIdentityForSession(session), session);
    }
    return [...byIdentity.values()];
  }, [getIdentityForSession, secondaryActiveSessions, sessions]);
  const collapsedSessionStatus = useMemo(() => {
    if (statusSessions.some((session) => session.isWaitingForPermission)) {
      return 'approval' as const;
    }
    if (statusSessions.some((session) => session.isWaitingForUserQuestion)) {
      return 'question' as const;
    }
    if (
      statusSessions.some((session) =>
        completedUnreadIds.has(getIdentityForSession(session)),
      )
    ) {
      return 'completed' as const;
    }
    return undefined;
  }, [completedUnreadIds, getIdentityForSession, statusSessions]);
  const collapsedSessionStatusLabel = collapsedSessionStatus
    ? t(
        collapsedSessionStatus === 'approval'
          ? 'sidebar.waitingForApproval'
          : collapsedSessionStatus === 'question'
            ? 'sidebar.userInputNeeded'
            : 'sidebar.completedUnread',
      )
    : undefined;
  const sessionPollInterval =
    projectExpanded || hasRunningSession || selectedSessionSource === 'channel'
      ? (hasRunningSession || selectedSessionSource === 'channel') && !error
        ? ACTIVE_SESSION_POLL_INTERVAL_MS
        : IDLE_SESSION_POLL_INTERVAL_MS
      : undefined;
  useSessionCatalogPolling(
    workspace.client,
    includePrimaryWorkspaceSessions ? catalogQuery : undefined,
    sessionCatalogRequestsEnabled && !primaryWorkspaceSessionLiveStateEnabled
      ? sessionPollInterval
      : undefined,
  );
  // Channel grouping rides the session poll cadence: instances added or
  // removed while the channel source is active must reach the grouping logic
  // without a source switch.
  const channelCatalogPollInFlightRef = useRef(false);
  useEffect(() => {
    if (!channelGroupingEnabled) return;
    // Back off on the channels hook's OWN failures too — a persistently
    // failing channels endpoint must not be re-requested every 2s.
    const pollInterval =
      !error && !channelCatalogError
        ? ACTIVE_SESSION_POLL_INTERVAL_MS
        : IDLE_SESSION_POLL_INTERVAL_MS;
    const intervalId = window.setInterval(() => {
      if (document.hidden || channelCatalogPollInFlightRef.current) return;
      channelCatalogPollInFlightRef.current = true;
      void reloadChannelCatalog().finally(() => {
        channelCatalogPollInFlightRef.current = false;
      });
    }, pollInterval);
    return () => window.clearInterval(intervalId);
  }, [
    channelCatalogError,
    channelGroupingEnabled,
    error,
    reloadChannelCatalog,
  ]);

  useEffect(() => {
    if (lastTrackedSessionSourceRef.current !== sessionSource) {
      lastTrackedSessionSourceRef.current = sessionSource;
      return;
    }
    if (loading || error) return;

    const runningBySessionId = new Map(
      sessions
        .filter((session) =>
          matchesSessionSource(session, selectedSessionSource),
        )
        .map((session) => [
          getIdentityForSession(session),
          Boolean(session.hasActivePrompt),
        ]),
    );
    const previousRunningBySessionId =
      previousRunningBySourceRef.current[sessionSource];
    previousRunningBySourceRef.current[sessionSource] = runningBySessionId;
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
          (previousRunningBySessionId.has(sessionIdentity) &&
            (!runningBySessionId.has(sessionIdentity) ||
              runningBySessionId.get(sessionIdentity)))
        ) {
          next.delete(sessionIdentity);
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [
    currentSessionIdentity,
    error,
    getIdentityForSession,
    loading,
    selectedSessionSource,
    sessionSource,
    sessions,
  ]);

  useEffect(() => {
    if (
      !collapsed ||
      secondaryActiveSnapshots.length !== secondaryActiveQueries.length ||
      secondaryActiveSnapshots.some(
        (snapshot) => snapshot.loading || snapshot.error,
      )
    ) {
      return;
    }
    const runningBySessionId = new Map(
      secondaryActiveSessions
        .filter((session) =>
          matchesSessionSource(session, selectedSessionSource),
        )
        .map((session) => [
          getIdentityForSession(session),
          Boolean(session.hasActivePrompt),
        ]),
    );
    const previousRunningBySessionId =
      previousSecondaryRunningBySourceRef.current[sessionSource];
    previousSecondaryRunningBySourceRef.current[sessionSource] =
      runningBySessionId;
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
        } else if (
          next.has(sessionIdentity) &&
          (sessionIdentity === currentSessionIdentity ||
            !runningBySessionId.has(sessionIdentity) ||
            isRunning)
        ) {
          next.delete(sessionIdentity);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [
    collapsed,
    currentSessionIdentity,
    getIdentityForSession,
    secondaryActiveQueries.length,
    secondaryActiveSessions,
    secondaryActiveSnapshots,
    selectedSessionSource,
    sessionSource,
  ]);

  const reconcileRemovedWorkspace = useCallback(
    async (removed: DaemonWorkspaceCapability) => {
      if (!workspaceRemovalMountedRef.current) return;
      if (selectedWorkspaceCwd === removed.cwd) {
        onSelectWorkspace?.(undefined);
      }
      sessionCatalogController.invalidateWorkspace(removed.cwd);
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
      sessionCatalogController,
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
    (workspaceCwd?: string) => {
      if (creatingSessionRef.current) return;

      creatingSessionRef.current = true;
      setCreatingSession(true);
      void (async () => {
        try {
          const created = await onNewSession(workspaceCwd);
          if (created) {
            bumpWorkspaceReload();
            const ownerCwd = workspaceCwd ?? primaryWorkspaceCwd;
            if (ownerCwd) {
              sessionCatalogController.refreshWorkspace(ownerCwd);
            }
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
    [
      bumpWorkspaceReload,
      onError,
      onNewSession,
      primaryWorkspaceCwd,
      sessionCatalogController,
      t,
    ],
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

  const startRename = useCallback(
    (session: DaemonSessionSummary) => {
      if (!canRenameSession(session)) return;
      const identity = getIdentityForSession(session);
      if (busySessionIdsRef.current.has(identity)) return;
      setEditingSession(session);
      setEditingSessionIdentity(identity);
      editingSessionIdentityRef.current = identity;
      setEditingName(getSessionLabel(session));
    },
    [canRenameSession, getIdentityForSession],
  );

  const cancelRename = useCallback(() => {
    setEditingSession(null);
    setEditingSessionIdentity(null);
    editingSessionIdentityRef.current = null;
    setEditingName('');
  }, []);
  useEffect(() => {
    if (editingSession && !canRenameSession(editingSession)) {
      cancelRename();
    }
  }, [canRenameSession, cancelRename, editingSession]);

  useEffect(() => {
    if (!collapsed) {
      setCollapsedSessionsOpen(false);
      setSearchOpen(false);
      setSearchQuery('');
      cancelRename();
      setGroupMenu(null);
    } else if (!collapsedSessionsOpen) {
      // A stale open search or rename editor would otherwise mount its
      // autofocused input inside the collapsed hover popover and steal
      // focus from the composer on every hover-open, so reset it whenever
      // the collapsed surface is not showing (sidebar collapse, hover-out,
      // or dismissal). Radix's outside-interaction
      // dismissal unmounts a focused input without firing blur. A stale
      // group picker would likewise block dismissal of the next
      // hover-opened switcher.
      setSearchOpen(false);
      setSearchQuery('');
      cancelRename();
      setGroupMenu(null);
    }
  }, [cancelRename, collapsed, collapsedSessionsOpen]);

  const saveRename = useCallback(() => {
    const nextName = editingName.trim();
    if (
      !nextName ||
      !editingSession ||
      editingSessionIdentity !== getIdentityForSession(editingSession) ||
      !canRenameSession(editingSession)
    ) {
      cancelRename();
      return;
    }
    const sessionId = editingSession.sessionId;
    const workspaceCwd = getSessionWorkspaceCwd(editingSession);
    const sessionIdentity = getIdentityForSession(editingSession);
    if (busySessionIdsRef.current.has(sessionIdentity)) {
      return;
    }
    setSessionBusy(sessionId, true, workspaceCwd);
    let renamed = false;
    const rename = isCurrentSession(editingSession)
      ? actions.renameSession(nextName)
      : workspaceCwd
        ? workspace.client
            .workspaceByCwd(workspaceCwd)
            .updateSessionMetadata(sessionId, { displayName: nextName })
        : workspace.client.updateSessionMetadata(sessionId, {
            displayName: nextName,
          });
    rename
      .then((result: SessionMetadataResult | void) => {
        renamed = true;
        // The daemon clamps displayName to 256 chars and reports the stored
        // value; propagate that instead of the locally typed string so the
        // catalog cache never disagrees with the daemon.
        const effectiveName =
          typeof result?.displayName === 'string' && result.displayName
            ? result.displayName
            : nextName;
        if (workspaceCwd) {
          if (onSessionRenameConfirmed) {
            onSessionRenameConfirmed(workspaceCwd, sessionId, effectiveName);
          } else {
            sessionCatalogController.renamed(
              workspaceCwd,
              sessionId,
              effectiveName,
            );
          }
          sessionCatalogController.refreshWorkspace(workspaceCwd);
        }
        // A late settle must not close an editor the user moved to another
        // session with while this request was in flight.
        if (editingSessionIdentityRef.current === sessionIdentity) {
          cancelRename();
        }
        bumpWorkspaceReload();
      })
      .catch((err: unknown) => {
        onError(err, t('sidebar.renameFailed'));
        if (editingSessionIdentityRef.current === sessionIdentity) {
          cancelRename();
        }
      })
      .finally(() => {
        if (!renamed && workspaceCwd) {
          sessionCatalogController.refreshWorkspace(workspaceCwd);
        }
        setSessionBusy(sessionId, false, workspaceCwd);
      });
  }, [
    actions,
    bumpWorkspaceReload,
    canRenameSession,
    cancelRename,
    editingName,
    editingSession,
    editingSessionIdentity,
    getIdentityForSession,
    getSessionWorkspaceCwd,
    isCurrentSession,
    onSessionRenameConfirmed,
    onError,
    sessionCatalogController,
    setSessionBusy,
    t,
    workspace.client,
  ]);

  const handleDeleteSession = useCallback(
    (session: DaemonSessionSummary) => {
      if (!canDeleteSession(session)) return;
      setDeleteCandidate(session);
    },
    [canDeleteSession],
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
      const activeExportScope = getActiveExportScope(session);
      if (
        !sessionActionItems.has('export') ||
        (archived
          ? !getArchivedExportWorkspaceCwd(session)
          : !activeExportScope) ||
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
          } else if (activeExportScope?.kind === 'primary') {
            result = await exportSession(sessionId, 'html');
          } else if (activeExportScope?.kind === 'locked') {
            result = await workspace.client
              .workspaceByCwd(activeExportScope.cwd)
              .exportSession(sessionId, { format: 'html' });
          } else {
            return;
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
      exportSession,
      getActiveExportScope,
      getArchivedExportWorkspaceCwd,
      getIdentityForSession,
      onError,
      setSessionExporting,
      sessionActionItems,
      t,
      workspace.client,
    ],
  );

  const confirmDeleteSession = useCallback(() => {
    if (!deleteCandidate) return;
    const sessionId = deleteCandidate.sessionId;
    const sessionIdentity = getIdentityForSession(deleteCandidate);
    if (!canDeleteSession(deleteCandidate)) {
      setDeleteCandidate(null);
      return;
    }
    const scope = resolveSessionWorkspaceScope(deleteCandidate);
    const isArchived = Boolean(deleteCandidate.isArchived);
    const removeSession =
      scope.kind === 'locked' || scope.kind === 'restricted'
        ? async (id: string) => {
            const result = await workspace.client
              .workspaceByCwd(scope.cwd)
              .deleteSessionsData([id]);
            const itemError = result.errors.find(
              (entry) => entry.sessionId === id,
            );
            if (itemError) throw new Error(itemError.error);
          }
        : scope.kind === 'primary'
          ? isArchived
            ? deleteArchivedSession
            : deleteSession
          : undefined;
    setDeleteCandidate(null);
    if (!removeSession) return;
    if (busySessionIdsRef.current.has(sessionIdentity)) return;
    setSessionBusy(sessionId, true, deleteCandidate.workspaceCwd);
    removeSession(sessionId)
      .then(() => {
        onSessionsDeleted?.([sessionId]);
        bumpWorkspaceReload();
      })
      .catch((err: unknown) => onError(err, t('sidebar.deleteFailed')))
      .finally(() => {
        const workspaceCwd =
          deleteCandidate.workspaceCwd ?? primaryWorkspaceCwd;
        if (scope.kind !== 'primary' && workspaceCwd) {
          sessionCatalogController.refreshWorkspace(workspaceCwd);
        }
        setSessionBusy(sessionId, false, deleteCandidate.workspaceCwd);
      });
  }, [
    bumpWorkspaceReload,
    canDeleteSession,
    deleteArchivedSession,
    deleteCandidate,
    deleteSession,
    getIdentityForSession,
    onError,
    onSessionsDeleted,
    primaryWorkspaceCwd,
    resolveSessionWorkspaceScope,
    sessionCatalogController,
    setSessionBusy,
    t,
    workspace.client,
  ]);

  const handleRenameFromMenu = useCallback(
    (session: DaemonSessionSummary) => {
      renameFocusSuppressRef.current = true;
      startRename(session);
    },
    [startRename],
  );

  const handleCreateGroup = useCallback(() => {
    if (!canOrganizeWorkspace()) return;
    setGroupMenu(null);
    setGroupName('');
    setGroupColor(getDefaultGroupColor(colorOptions));
    setLastValidCustomGroupColor(DEFAULT_CUSTOM_GROUP_COLOR);
    setGroupEditor({ mode: 'create' });
  }, [canOrganizeWorkspace, colorOptions]);

  const handleCreateWorkspaceGroup = useCallback(
    (workspaceCwd: string) => {
      if (!canOrganizeWorkspace(workspaceCwd)) return;
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
    [canOrganizeWorkspace, onError, t, workspace.client],
  );

  const handleCreateGroupForSession = useCallback(
    (session: DaemonSessionSummary) => {
      if (!canOrganizeSession(session, 'group')) return;
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
    [canOrganizeSession, colorOptions],
  );

  const handleRenameGroup = useCallback(
    (group: DaemonSessionGroup, workspaceCwd?: string) => {
      if (!canOrganizeWorkspace(workspaceCwd)) return;
      setGroupName(group.name);
      setGroupColor(group.color);
      setLastValidCustomGroupColor(
        normalizeHexColorInput(group.color) ?? DEFAULT_CUSTOM_GROUP_COLOR,
      );
      setGroupEditor({ mode: 'edit', group, workspaceCwd });
    },
    [canOrganizeWorkspace],
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
    if (
      !canOrganizeWorkspace(groupEditor.workspaceCwd) ||
      (groupEditor.targetSession &&
        !canOrganizeSession(groupEditor.targetSession, 'group'))
    ) {
      closeGroupEditor();
      return;
    }
    const name = groupName.trim();
    const color = normalizeGroupColorInput(
      groupColor,
      colorOptions.length > 0 ? colorOptions : SESSION_GROUP_COLORS,
    );
    if (!name || !color) return;
    void (async () => {
      setGroupBusy(true);
      const reportCreatedGroupAssignmentFailure = (error: unknown) => {
        setGroupEditor(null);
        setGroupName('');
        if (groupEditor.workspaceCwd) {
          bumpWorkspaceReload();
        } else {
          void reloadGroups().catch(() => undefined);
        }
        onError(error, t('sidebar.groupAssignFailedAfterCreate'));
      };
      try {
        const scope = resolveWorkspaceScope(groupEditor.workspaceCwd);
        const groupActions =
          scope.kind === 'primary'
            ? workspaceActions
            : scope.kind === 'locked' || scope.kind === 'restricted'
              ? workspace.client.workspaceByCwd(scope.cwd)
              : undefined;
        if (!groupActions) return;
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
              const livePolicy = groupAssignmentPolicyRef.current;
              const targetScope = livePolicy?.resolveWorkspaceScope(
                groupEditor.targetSession.workspaceCwd,
              );
              if (
                !livePolicy ||
                !targetScope ||
                !livePolicy.canOrganizeSession(
                  groupEditor.targetSession,
                  'group',
                ) ||
                targetScope.kind !== scope.kind ||
                targetScope.cwd !== scope.cwd
              ) {
                reportCreatedGroupAssignmentFailure(
                  new Error(t('sidebar.groupAssignFailedAfterCreate')),
                );
                return;
              }
              const targetActions = livePolicy.getSessionWorkspaceActions(
                groupEditor.targetSession,
              );
              if (!targetActions) {
                reportCreatedGroupAssignmentFailure(
                  new Error(t('sidebar.groupAssignFailedAfterCreate')),
                );
                return;
              }
              await targetActions.updateSessionOrganization(
                groupEditor.targetSession.sessionId,
                // Assigning a named group clears any color tag (single choice
                // in the UI), matching assignSessionGroup.
                { groupId: group.id, color: null },
              );
              bumpWorkspaceReload();
            } catch (err) {
              reportCreatedGroupAssignmentFailure(err);
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
        const workspaceCwd = groupEditor.workspaceCwd ?? primaryWorkspaceCwd;
        if (workspaceCwd) {
          sessionCatalogController.refreshWorkspace(workspaceCwd);
        }
        setGroupBusy(false);
      }
    })();
  }, [
    bumpWorkspaceReload,
    colorOptions,
    groupColor,
    groupEditor,
    groupName,
    canOrganizeSession,
    canOrganizeWorkspace,
    closeGroupEditor,
    onError,
    primaryWorkspaceCwd,
    reloadGroups,
    resolveWorkspaceScope,
    sessionCatalogController,
    t,
    workspaceActions,
    workspace.client,
  ]);

  const handleDeleteGroup = useCallback(
    (group: DaemonSessionGroup, workspaceCwd?: string) => {
      if (!canOrganizeWorkspace(workspaceCwd)) return;
      setDeleteGroupCandidate({ group, workspaceCwd });
    },
    [canOrganizeWorkspace],
  );

  const confirmDeleteGroup = useCallback(() => {
    if (!deleteGroupCandidate) return;
    if (!canOrganizeWorkspace(deleteGroupCandidate.workspaceCwd)) {
      setDeleteGroupCandidate(null);
      return;
    }
    setGroupBusy(true);
    const scope = resolveWorkspaceScope(deleteGroupCandidate.workspaceCwd);
    const groupActions =
      scope.kind === 'primary'
        ? workspaceActions
        : scope.kind === 'locked' || scope.kind === 'restricted'
          ? workspace.client.workspaceByCwd(scope.cwd)
          : undefined;
    if (!groupActions) {
      setGroupBusy(false);
      return;
    }
    groupActions
      .deleteSessionGroup(deleteGroupCandidate.group.id)
      .then(() => {
        setDeleteGroupCandidate(null);
        if (deleteGroupCandidate.workspaceCwd) {
          bumpWorkspaceReload();
        }
      })
      .catch((err: unknown) => onError(err, t('sidebar.groupDeleteFailed')))
      .then(() =>
        deleteGroupCandidate.workspaceCwd
          ? undefined
          : reloadGroups().catch(() => undefined),
      )
      .finally(() => {
        const workspaceCwd =
          deleteGroupCandidate.workspaceCwd ?? primaryWorkspaceCwd;
        if (workspaceCwd) {
          sessionCatalogController.refreshWorkspace(workspaceCwd);
        }
        setGroupBusy(false);
      });
  }, [
    deleteGroupCandidate,
    canOrganizeWorkspace,
    onError,
    primaryWorkspaceCwd,
    reloadGroups,
    t,
    bumpWorkspaceReload,
    resolveWorkspaceScope,
    sessionCatalogController,
    workspace.client,
    workspaceActions,
  ]);

  useEffect(() => {
    if (deleteCandidate && !canDeleteSession(deleteCandidate)) {
      setDeleteCandidate(null);
    }
  }, [canDeleteSession, deleteCandidate]);

  useEffect(() => {
    if (groupMenu && !canOrganizeSession(groupMenu.session, 'group')) {
      setGroupMenu(null);
    }
  }, [canOrganizeSession, groupMenu]);

  useEffect(() => {
    if (
      groupEditor &&
      (!canOrganizeWorkspace(groupEditor.workspaceCwd) ||
        (groupEditor.targetSession &&
          !canOrganizeSession(groupEditor.targetSession, 'group')))
    ) {
      setGroupEditor(null);
      setGroupName('');
    }
  }, [canOrganizeSession, canOrganizeWorkspace, groupEditor]);

  useEffect(() => {
    if (
      deleteGroupCandidate &&
      !canOrganizeWorkspace(deleteGroupCandidate.workspaceCwd)
    ) {
      setDeleteGroupCandidate(null);
    }
  }, [canOrganizeWorkspace, deleteGroupCandidate]);

  const handleTogglePin = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (
        !canOrganizeSession(session, 'pin') ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      const targetPinned = !session.isPinned;
      const workspaceCwd = session.workspaceCwd ?? primaryWorkspaceCwd;
      const optimisticPinnedAt = new Date().toISOString();
      const storeToggle = (pinned: boolean, pinnedAt?: string): void => {
        if (!workspaceCwd) return;
        sessionCatalogController.toggleSessionPinned(workspaceCwd, session, {
          pinned,
          ...(pinned && pinnedAt !== undefined ? { pinnedAt } : {}),
        });
      };
      let rpcSucceeded = false;
      const markRpcSettled = (): void => {
        setOptimisticPins((previous) => {
          const entry = previous.get(sessionIdentity);
          if (!entry) return previous;
          const next = new Map(previous);
          next.set(sessionIdentity, { ...entry, rpcSettled: true });
          return next;
        });
      };
      const applyOptimistic = (): void => {
        setOptimisticPins((previous) => {
          const next = new Map(previous);
          next.set(sessionIdentity, {
            session,
            pinned: targetPinned,
            rpcSettled: false,
            ...(targetPinned ? { pinnedAt: optimisticPinnedAt } : {}),
          });
          return next;
        });
      };
      const rollbackOptimistic = (): void => {
        setOptimisticPins((previous) => {
          if (!previous.has(sessionIdentity)) return previous;
          const next = new Map(previous);
          next.delete(sessionIdentity);
          return next;
        });
      };
      // Reflect the toggle immediately. The catalog store applies it to
      // every loaded page so churn cannot drop it, and the refresh below
      // replaces those pages with authoritative state when it lands.
      applyOptimistic();
      storeToggle(targetPinned, optimisticPinnedAt);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      if (!sessionActions) {
        rollbackOptimistic();
        storeToggle(!targetPinned, session.pinnedAt);
        setSessionBusy(sessionId, false, session.workspaceCwd);
        return;
      }
      sessionActions
        .updateSessionOrganization(sessionId, {
          isPinned: targetPinned,
        })
        .then(() => {
          rpcSucceeded = true;
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => {
          rollbackOptimistic();
          storeToggle(!targetPinned, session.pinnedAt);
          onError(err, t('sidebar.organizationFailed'));
        })
        .finally(() => {
          if (workspaceCwd) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
          if (rpcSucceeded) markRpcSettled();
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      primaryWorkspaceCwd,
      canOrganizeSession,
      sessionCatalogController,
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
      if (!canArchiveSession(session)) return;
      if (busySessionIdsRef.current.has(sessionIdentity)) return;
      const scope = resolveSessionWorkspaceScope(session);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      void (async () => {
        try {
          if (scope.kind === 'locked' || scope.kind === 'restricted') {
            const result = await workspace.client
              .workspaceByCwd(scope.cwd)
              .archiveSessionsData([sessionId]);
            const itemError = result.errors.find(
              (entry) => entry.sessionId === sessionId,
            );
            if (itemError) {
              onError(new Error(itemError.error), t('sidebar.archiveFailed'));
            }
          } else if (scope.kind === 'primary') {
            await archiveSession(sessionId);
          } else {
            return;
          }
        } catch (err) {
          onError(err, t('sidebar.archiveFailed'));
        } finally {
          bumpWorkspaceReload();
          const workspaceCwd = session.workspaceCwd ?? primaryWorkspaceCwd;
          if (scope.kind !== 'primary' && workspaceCwd) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
          setSessionBusy(sessionId, false, session.workspaceCwd);
        }
      })();
    },
    [
      archiveSession,
      bumpWorkspaceReload,
      canArchiveSession,
      getIdentityForSession,
      onError,
      primaryWorkspaceCwd,
      sessionCatalogController,
      setSessionBusy,
      t,
      resolveSessionWorkspaceScope,
      workspace.client,
    ],
  );

  const handleUnarchive = useCallback(
    (session: DaemonSessionSummary) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (!canUnarchiveSession(session)) return;
      if (busySessionIdsRef.current.has(sessionIdentity)) return;
      const scope = resolveSessionWorkspaceScope(session);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      void (async () => {
        try {
          if (scope.kind === 'locked' || scope.kind === 'restricted') {
            const result = await workspace.client
              .workspaceByCwd(scope.cwd)
              .unarchiveSessionsData([sessionId]);
            const itemError = result.errors.find(
              (entry) => entry.sessionId === sessionId,
            );
            if (itemError) {
              onError(new Error(itemError.error), t('sidebar.unarchiveFailed'));
            }
          } else if (scope.kind === 'primary') {
            await unarchiveSession(sessionId);
          } else {
            return;
          }
        } catch (err) {
          onError(err, t('sidebar.unarchiveFailed'));
        } finally {
          bumpWorkspaceReload();
          const workspaceCwd = session.workspaceCwd ?? primaryWorkspaceCwd;
          if (scope.kind !== 'primary' && workspaceCwd) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
          setSessionBusy(sessionId, false, session.workspaceCwd);
        }
      })();
    },
    [
      bumpWorkspaceReload,
      canUnarchiveSession,
      getIdentityForSession,
      onError,
      primaryWorkspaceCwd,
      sessionCatalogController,
      setSessionBusy,
      t,
      unarchiveSession,
      resolveSessionWorkspaceScope,
      workspace.client,
    ],
  );

  const openGroupMenuFromAnchor = useCallback(
    async (anchorEl: HTMLElement, session: DaemonSessionSummary) => {
      if (!canOrganizeSession(session, 'group')) return;
      let groupCount = 0;
      try {
        const sessionActions = getSessionWorkspaceActions(session);
        if (!sessionActions) return;
        const catalog = await sessionActions.listSessionGroups();
        if (!canOrganizeSession(session, 'group')) return;
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
    [canOrganizeSession, getSessionWorkspaceActions, onError, t],
  );

  const assignSessionGroup = useCallback(
    (session: DaemonSessionSummary, groupId: string | null) => {
      const sessionId = session.sessionId;
      const sessionIdentity = getIdentityForSession(session);
      if (
        !canOrganizeSession(session, 'group') ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      if (!sessionActions) {
        setSessionBusy(sessionId, false, session.workspaceCwd);
        return;
      }
      sessionActions
        // Group and color are a single choice in the UI: assigning a named
        // group (or "Ungrouped", groupId=null) clears any color tag.
        .updateSessionOrganization(sessionId, { groupId, color: null })
        .then(() => {
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          const workspaceCwd = session.workspaceCwd ?? primaryWorkspaceCwd;
          if (workspaceCwd) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      primaryWorkspaceCwd,
      canOrganizeSession,
      sessionCatalogController,
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
        !canOrganizeSession(session, 'group') ||
        busySessionIdsRef.current.has(sessionIdentity)
      ) {
        return;
      }
      setGroupMenu(null);
      setSessionBusy(sessionId, true, session.workspaceCwd);
      const sessionActions = getSessionWorkspaceActions(session);
      if (!sessionActions) {
        setSessionBusy(sessionId, false, session.workspaceCwd);
        return;
      }
      sessionActions
        // Picking a color clears any named-group assignment (single choice).
        .updateSessionOrganization(sessionId, { color, groupId: null })
        .then(() => {
          bumpWorkspaceReload();
        })
        .catch((err: unknown) => onError(err, t('sidebar.organizationFailed')))
        .finally(() => {
          const workspaceCwd = session.workspaceCwd ?? primaryWorkspaceCwd;
          if (workspaceCwd) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
          setSessionBusy(sessionId, false, session.workspaceCwd);
        });
    },
    [
      bumpWorkspaceReload,
      getIdentityForSession,
      getSessionWorkspaceActions,
      onError,
      primaryWorkspaceCwd,
      canOrganizeSession,
      sessionCatalogController,
      setSessionBusy,
      t,
    ],
  );

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sourceScopedSessions = sessions
      .map(applyOptimisticPin)
      .filter((session) =>
        matchesSessionSource(session, selectedSessionSource),
      );
    const unpinnedSessions =
      selectedSessionSource === 'channel'
        ? sourceScopedSessions
        : sourceScopedSessions.filter((session) => !session.isPinned);
    const nextSessions = query
      ? unpinnedSessions.filter((session) => {
          const label = getSessionLabel(session).toLowerCase();
          return (
            label.includes(query) ||
            session.sessionId.toLowerCase().includes(query) ||
            sessionMatchesGitQuery(session, query)
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
  }, [
    applyOptimisticPin,
    organizationEnabled,
    searchQuery,
    selectedSessionSource,
    sessions,
  ]);

  const channelCatalogLoaded = channelCatalogData !== undefined;
  const channelSessionSections = useMemo(
    () =>
      selectedSessionSource === 'channel' && channelCatalogLoaded
        ? groupSessionsByChannelType(
            filteredSessions,
            channelTypeCatalog,
            channelInstances,
            t('sidebar.channelType.other'),
          )
        : null,
    [
      channelCatalogLoaded,
      channelInstances,
      channelTypeCatalog,
      filteredSessions,
      selectedSessionSource,
      t,
    ],
  );

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
    const activeSections = channelSessionSections ?? sessionSections;
    if (selectedSessionSource === 'channel') {
      if (!channelCatalogLoaded) return;
      // The refetch for the new source retains the previous source's page
      // until it settles; wait for a page fetched for the channel source.
      if (settledSessionsSourceRef.current !== 'channel') return;
    } else {
      if (!organizationEnabled) return;
      if (!groupsCatalogReady || !sessionsCatalogReady) return;
    }
    const unseenIds = activeSections
      .map((section) => section.id)
      .filter((id) => !knownSessionSectionIdsRef.current.has(id));
    const isInitialCatalog =
      awaitingInitialSessionCatalogBySourceRef.current[sessionSource];
    if (isInitialCatalog) {
      // First-sync registration must reflect the full unfiltered catalog:
      // sections hidden by an active search would never register and would
      // later auto-collapse as mid-session additions. An empty first catalog
      // keeps the latch so the first real sections still register as initial
      // — channel sessions are externally driven and can arrive while the
      // tab is open on an empty settle.
      if (searchQuery.trim() || activeSections.length === 0) return;
      awaitingInitialSessionCatalogBySourceRef.current[sessionSource] = false;
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
    channelCatalogLoaded,
    channelSessionSections,
    organizationEnabled,
    searchQuery,
    selectedSessionSource,
    sessionSections,
    sessionSource,
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
      if (collapsed || mobileOpen) return;
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
    [collapsed, mobileOpen, onCollapsedChange, sidebarWidth],
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
    colorOptions.length > 0 ? colorOptions : SESSION_GROUP_COLORS;
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
      } = {},
    ) => {
      const { isArchived = false } = options;
      const sessionIdentity = getIdentityForSession(session);
      const label = getSessionLabel(session);
      const stamp = session.updatedAt || session.createdAt;
      const time = stamp ? formatRelativeTime(stamp, t) : '';
      const busy = busySessionIds.has(sessionIdentity);
      const exporting = exportingSessionIds.has(sessionIdentity);
      const completedUnread =
        !isCurrentSession(session) && completedUnreadIds.has(sessionIdentity);
      const isEditing = editingSessionIdentity === sessionIdentity;
      const gitIcon = session.worktree ? (
        <GitForkIcon aria-label={t('sidebar.newWorktreeTask')} />
      ) : session.branch ? (
        <GitBranchIcon aria-label={session.branch.name} />
      ) : null;
      const prBadge = <SessionPrBadge prs={session.prs ?? []} />;
      const withDetails = (row: ReactElement) => (
        <Fragment key={sessionIdentity}>
          {sessionActionItems.has('details') ? (
            <SessionDetailsTooltip
              session={{
                ...session,
                workspaceCwd: getSessionWorkspaceCwd(session) ?? '',
              }}
              label={label}
              time={time}
              completedUnread={completedUnread}
            >
              {row}
            </SessionDetailsTooltip>
          ) : (
            row
          )}
        </Fragment>
      );
      if (isArchived) {
        const archivedExportWorkspaceCwd =
          getArchivedExportWorkspaceCwd(session);
        const showArchivedExport =
          sessionActionItems.has('export') &&
          Boolean(archivedExportWorkspaceCwd);
        const showArchivedUnarchive = canUnarchiveSession(session);
        const showArchivedDelete = canDeleteSession(session);
        const showArchivedRename = canRenameSession(session);
        const hasArchivedActions =
          showArchivedExport ||
          showArchivedUnarchive ||
          showArchivedDelete ||
          showArchivedRename;
        return withDetails(
          <div
            className={cx(
              styles.sessionRow,
              styles.archivedRow,
              busy && styles.busySession,
            )}
            onMouseEnter={(event) =>
              measureSessionTitleScroll(event.currentTarget)
            }
          >
            {isEditing ? (
              <form
                className={styles.renameForm}
                onKeyDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onSubmit={(event) => {
                  event.preventDefault();
                  saveRename();
                }}
              >
                <input
                  autoFocus
                  aria-label={`${t('sidebar.rename')}: ${label}`}
                  className={styles.renameInput}
                  maxLength={256}
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={cancelRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') cancelRename();
                  }}
                />
              </form>
            ) : (
              <span className={styles.sessionText} data-web-shell-session-title>
                <span className={styles.sessionTextInner}>{label}</span>
              </span>
            )}
            {prBadge}
            <div
              className={styles.sessionMetaSlot}
              style={
                hasArchivedActions
                  ? ({ '--session-actions-width': '26px' } as CSSProperties)
                  : undefined
              }
            >
              {gitIcon && (
                <span className={styles.sessionGitIcon}>{gitIcon}</span>
              )}
              {hasArchivedActions && (
                <div
                  className={styles.sessionActions}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <SessionMenu onOpenChange={handleSessionMenuOpenChange}>
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
                      style={SESSION_MENU_PORTAL_STYLE}
                      onPointerDownOutside={handleSessionMenuPointerDownOutside}
                      onCloseAutoFocus={handleSessionMenuCloseAutoFocus}
                    >
                      <DropdownMenuGroup>
                        {showArchivedRename && (
                          <DropdownMenuItem
                            disabled={busy}
                            onSelect={() => handleRenameFromMenu(session)}
                          >
                            <PencilIcon />
                            {t('sidebar.rename')}
                          </DropdownMenuItem>
                        )}
                        {showArchivedExport && (
                          <DropdownMenuItem
                            disabled={exporting}
                            onSelect={() => handleExportSession(session)}
                          >
                            <DownloadIcon />
                            {t('sidebar.export')}
                          </DropdownMenuItem>
                        )}
                        {showArchivedUnarchive && (
                          <DropdownMenuItem
                            onSelect={() => handleUnarchive(session)}
                          >
                            <ArchiveRestoreIcon />
                            {t('sidebar.unarchive')}
                          </DropdownMenuItem>
                        )}
                        {showArchivedDelete && (
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => handleDeleteSession(session)}
                          >
                            <Trash2Icon />
                            {t('sidebar.delete')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </SessionMenu>
                </div>
              )}
            </div>
          </div>,
        );
      }

      const isCurrent = isCurrentSession(session);
      const needsUserInput =
        !session.isWaitingForPermission && session.isWaitingForUserQuestion;
      const attentionLabel = session.isWaitingForPermission
        ? t('sidebar.waitingForApproval')
        : needsUserInput
          ? t('sidebar.userInputNeeded')
          : null;
      const showPin = canOrganizeSession(session, 'pin');
      const showArchive =
        sessionActionItems.has('archive') && canMutateSessionArchive(session);
      const showRename = canRenameSession(session);
      const activeExportScope = getActiveExportScope(session);
      const showExport =
        sessionActionItems.has('export') && Boolean(activeExportScope);
      const showDelete = canShowDeleteSession(session);
      const inlineActionCount =
        Number(showPin && inlineActionItems.has('pin')) +
        Number(showArchive && inlineActionItems.has('archive')) +
        Number(showRename && inlineActionItems.has('rename')) +
        Number(showExport && inlineActionItems.has('export')) +
        Number(showDelete && inlineActionItems.has('delete'));
      const showMoreActions =
        (showPin && !inlineActionItems.has('pin')) ||
        (showArchive && !inlineActionItems.has('archive')) ||
        (showRename && !inlineActionItems.has('rename')) ||
        canOrganizeSession(session, 'group') ||
        (showExport && !inlineActionItems.has('export')) ||
        (showDelete && !inlineActionItems.has('delete'));
      const sessionActionCount = inlineActionCount + Number(showMoreActions);
      return withDetails(
        <div
          className={cx(
            styles.sessionRow,
            isCurrent && styles.currentSession,
            session.isPinned && styles.pinnedSession,
            session.hasActivePrompt && styles.runningSession,
            busy && styles.busySession,
          )}
          onMouseEnter={(event) =>
            measureSessionTitleScroll(event.currentTarget)
          }
          onFocus={(event) => measureSessionTitleScroll(event.currentTarget)}
          role="button"
          tabIndex={0}
          aria-current={isCurrent ? 'page' : undefined}
          onClick={() =>
            handleLoadSession(session.sessionId, session.workspaceCwd)
          }
          onDoubleClick={() => {
            if (canRenameSession(session)) startRename(session);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              handleLoadSession(session.sessionId, session.workspaceCwd);
            }
          }}
        >
          <span className={styles.sessionStatusSlot}>
            {completedUnread ? (
              <span className={styles.sessionStatusDot} aria-hidden="true" />
            ) : null}
          </span>
          {isEditing && canRenameSession(session) ? (
            <form
              className={styles.renameForm}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                saveRename();
              }}
            >
              <input
                autoFocus
                aria-label={`${t('sidebar.rename')}: ${label}`}
                className={styles.renameInput}
                maxLength={256}
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
              <span className={styles.sessionText} data-web-shell-session-title>
                <span className={styles.sessionTextInner}>{label}</span>
              </span>
              {prBadge}
              <div
                className={styles.sessionMetaSlot}
                style={
                  sessionActionCount > 0
                    ? ({
                        '--session-actions-width': `${sessionActionCount * 26}px`,
                      } as CSSProperties)
                    : undefined
                }
              >
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
                ) : !attentionLabel && gitIcon ? (
                  <span className={styles.sessionGitIcon}>{gitIcon}</span>
                ) : null}
                {(showPin ||
                  showArchive ||
                  showRename ||
                  showExport ||
                  showDelete ||
                  canOrganizeSession(session, 'group')) && (
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
                          visible: showPin && inlineActionItems.has('pin'),
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
                            showArchive && inlineActionItems.has('archive'),
                          onClick: () => handleArchive(session),
                        },
                        {
                          key: 'rename',
                          icon: <PencilIcon size={16} strokeWidth={1.2} />,
                          label: t('sidebar.rename'),
                          disabled: busy,
                          visible:
                            showRename && inlineActionItems.has('rename'),
                          onClick: () => handleRenameFromMenu(session),
                        },
                        {
                          key: 'export',
                          icon: <DownloadIcon size={16} strokeWidth={1.2} />,
                          label: t('sidebar.export'),
                          disabled: exporting,
                          visible:
                            showExport && inlineActionItems.has('export'),
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
                            showDelete && inlineActionItems.has('delete'),
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
                              action.active && styles.activeSessionActionButton,
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
                    {showMoreActions ? (
                      <SessionMenu onOpenChange={handleSessionMenuOpenChange}>
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
                          style={SESSION_MENU_PORTAL_STYLE}
                          onPointerDownOutside={
                            handleSessionMenuPointerDownOutside
                          }
                          onCloseAutoFocus={handleSessionMenuCloseAutoFocus}
                        >
                          <DropdownMenuGroup>
                            {showPin && !inlineActionItems.has('pin') && (
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
                            {showArchive &&
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
                            {showRename && !inlineActionItems.has('rename') && (
                              <DropdownMenuItem
                                disabled={busy}
                                onSelect={() => handleRenameFromMenu(session)}
                              >
                                <PencilIcon />
                                {t('sidebar.rename')}
                              </DropdownMenuItem>
                            )}
                            {canOrganizeSession(session, 'group') && (
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
                            {showExport && !inlineActionItems.has('export') && (
                              <DropdownMenuItem
                                disabled={exporting}
                                onSelect={() => handleExportSession(session)}
                              >
                                <DownloadIcon />
                                {t('sidebar.export')}
                              </DropdownMenuItem>
                            )}
                            {showDelete && !inlineActionItems.has('delete') && (
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
                            )}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </SessionMenu>
                    ) : null}
                  </div>
                )}
              </div>
            </>
          )}
        </div>,
      );
    },
    [
      busySessionIds,
      canDeleteSession,
      canShowDeleteSession,
      canOrganizeSession,
      canRenameSession,
      canUnarchiveSession,
      canMutateSessionArchive,
      cancelRename,
      completedUnreadIds,
      editingName,
      editingSessionIdentity,
      exportingSessionIds,
      getArchivedExportWorkspaceCwd,
      getActiveExportScope,
      getIdentityForSession,
      getSessionWorkspaceCwd,
      handleArchive,
      handleDeleteSession,
      handleExportSession,
      handleLoadSession,
      handleRenameFromMenu,
      handleSessionMenuCloseAutoFocus,
      handleSessionMenuOpenChange,
      handleSessionMenuPointerDownOutside,
      handleTogglePin,
      handleUnarchive,
      isCurrentSession,
      openGroupMenuFromAnchor,
      saveRename,
      sessionActionItems,
      inlineActionItems,
      startRename,
      t,
    ],
  );

  const body = useMemo(() => {
    const renderFlatSessions = () => {
      const showAll =
        editingSessionIdentity !== null ||
        showAllProjectSessions ||
        Boolean(searchQuery.trim());
      const displayedSessions = showAll
        ? filteredSessions
        : filteredSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT);
      return (
        <>
          {displayedSessions.map((session) => renderSessionRow(session))}
          {!showAll &&
            filteredSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT && (
              <button
                type="button"
                className={styles.showAllSessions}
                onClick={() => setShowAllProjectSessions(true)}
              >
                {t('sidebar.showAllSessions')}
              </button>
            )}
        </>
      );
    };
    // Gate notices on the resource, not the filtered view: background
    // refreshes set loading/error while retaining the settled page, so a
    // filter-empty or empty-but-settled view must not flash or swap to retry.
    if (loading && sessionsPage === undefined) {
      return (
        <div className={styles.notice}>{t('sidebar.loadingSessions')}</div>
      );
    }
    if (error && sessionsPage === undefined) {
      return (
        <button
          className={styles.retry}
          type="button"
          onClick={() => void reload({ interactive: true })}
        >
          {t('sidebar.loadFailed')}
        </button>
      );
    }
    if (
      filteredSessions.length === 0 &&
      (selectedSessionSource === 'channel' ||
        channelSessionSections !== null ||
        searchQuery.trim() ||
        !organizationEnabled ||
        sessionSections.length === 0)
    ) {
      return <div className={styles.notice}>{t('sidebar.noSessions')}</div>;
    }
    if (channelSessionSections) {
      return channelSessionSections.map((section) => (
        <SessionGroupSection
          key={section.id}
          id={section.id}
          label={section.label}
          count={section.sessions.length}
          limitSessions={editingSessionIdentity === null && !searchQuery.trim()}
          expanded={!collapsedSessionSectionIds.has(section.id)}
          onToggle={() => toggleSessionSection(section.id)}
        >
          {section.sessions.map((session) => renderSessionRow(session))}
        </SessionGroupSection>
      ));
    }
    if (selectedSessionSource === 'channel') {
      return renderFlatSessions();
    }
    if (!organizationEnabled) {
      return renderFlatSessions();
    }
    if (sessionSections.length === 0) {
      return renderFlatSessions();
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
          limitSessions={editingSessionIdentity === null && !searchQuery.trim()}
          expanded={expanded}
          onToggle={() => toggleSessionSection(section.id)}
          onRename={
            section.kind === 'group' && group && canOrganizeWorkspace()
              ? () => handleRenameGroup(group)
              : undefined
          }
          onDelete={
            section.kind === 'group' && group && canOrganizeWorkspace()
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
    canOrganizeWorkspace,
    channelSessionSections,
    editingSessionIdentity,
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
    selectedSessionSource,
    sessionSections,
    sessionsPage,
    showAllProjectSessions,
    t,
    toggleSessionSection,
  ]);

  const archivedSection = useMemo(() => {
    if (!sessionArchiveEnabled || searchQuery.trim()) return null;

    const header = (
      <button
        type="button"
        className={styles.archivedHeader}
        aria-expanded={archivedExpanded}
        onClick={toggleArchived}
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
          void reloadArchived({ interactive: true }).catch(() => undefined);
          for (const workspaceCwd of secondaryWorkspaceCwds) {
            sessionCatalogController.refreshWorkspace(workspaceCwd);
          }
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
    effectiveArchivedError,
    effectiveArchivedLoading,
    reloadArchived,
    renderSessionRow,
    searchQuery,
    secondaryWorkspaceCwds,
    sessionCatalogController,
    sessionArchiveEnabled,
    t,
    toggleArchived,
  ]);
  return (
    <>
      <aside
        ref={sidebarRef}
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
        {primaryNavItems.has('newTask') && (
          <div
            className={cx(
              styles.newTaskNav,
              bodyScrolled && styles.newTaskNavScrolled,
            )}
          >
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
          </div>
        )}
        <div
          className={styles.body}
          onScroll={(event) =>
            setBodyScrolled(event.currentTarget.scrollTop > 0)
          }
        >
          {hasScrollingPrimaryNav && (
            <div className={styles.primaryNav}>
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
              {primaryNavItems.has('channels') && (
                <button
                  className={styles.pluginButton}
                  type="button"
                  title={t('sidebar.channels')}
                  aria-label={t('sidebar.channels')}
                  onClick={onOpenChannels}
                >
                  <span className={styles.navIcon}>
                    <RadioTowerIcon size={16} strokeWidth={1.2} />
                  </span>
                  {!collapsed && <span>{t('sidebar.channels')}</span>}
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
          )}
          <SidebarSessionSurface
            collapsed={collapsed}
            label={t('sidebar.project')}
            status={collapsedSessionStatus}
            statusLabel={collapsedSessionStatusLabel}
            width={sidebarWidth}
            open={collapsedSessionsOpen}
            onOpenChange={setCollapsedSessionsOpen}
            isCloseBlocked={isCollapsedCloseBlocked}
          >
            {sourceMetadataEnabled && (
              <Tabs
                className="px-2 pb-2"
                value={sessionSource}
                onValueChange={(value) =>
                  setSessionSource(value as SidebarSessionSource)
                }
              >
                <TabsList
                  className="w-full"
                  aria-label={t('sidebar.sessionSource')}
                >
                  <TabsTrigger value="default">
                    <ListTodoIcon />
                    {t('sidebar.sessionSource.tasks')}
                  </TabsTrigger>
                  <TabsTrigger value="channel">
                    <MessageCircleIcon />
                    {t('sidebar.sessionSource.channels')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {selectedSessionSource !== 'channel' &&
              pinnedSessions.length > 0 && (
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
                      {pinnedSessions.map((session) =>
                        renderSessionRow(session),
                      )}
                    </div>
                  )}
                </>
              )}
            {liveWorkspaces.map((ws) => (
              <WorkspaceSection
                key={ws.id}
                workspace={ws}
                renderHeader={(expanded) => (
                  <>
                    <RadioTowerIcon
                      size={16}
                      strokeWidth={1.2}
                      aria-hidden="true"
                    />
                    <span className={styles.liveWorkspaceLabel}>
                      {t('sidebar.live')}
                    </span>
                    {expanded ? (
                      <ChevronDownIcon
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRightIcon
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    )}
                  </>
                )}
                client={workspace.client}
                reloadToken={workspaceSessionsReloadToken}
                untrustedLabel={t('sidebar.workspaceUntrusted')}
                readOnlyLabel={t('sidebar.workspaceReadOnly')}
                trustToOpenLabel={t('sidebar.workspaceTrustToOpen')}
                noSessionsLabel={t('sidebar.noSessions')}
                loadErrorLabel={t('sidebar.loadFailed')}
                organizationEnabled={false}
                sessionCatalogRequestsEnabled={sessionCatalogRequestsEnabled}
                sessionLiveStateEnabled={
                  workspaceSessionLiveStateEnabled &&
                  liveStateWorkspaceCwdSet.has(ws.cwd)
                }
                sourceType={sourceMetadataEnabled ? 'default' : undefined}
                channelGroupingEnabled={false}
                ungroupedLabel={t('sidebar.groupUngrouped')}
                excludePinned={selectedSessionSource !== 'channel'}
                mapSession={applyOptimisticPin}
                limitSessions={editingSessionIdentity === null}
                autoExpandKey={
                  autoExpandWorkspace?.id === ws.id
                    ? autoExpandWorkspace.key
                    : undefined
                }
                renderSession={(session) =>
                  renderSessionRow({ ...session, workspaceCwd: ws.cwd })
                }
                showSessionDetails={sessionActionItems.has('details')}
              />
            ))}
            {!hideProjectHeader && (
              <div className={styles.projectsHeader}>
                <button
                  className={styles.projectsHeaderToggle}
                  type="button"
                  aria-expanded={projectsExpanded}
                  onClick={() => {
                    const nextExpanded = !projectsExpanded;
                    writeWorkspaceExpanded('projects', nextExpanded);
                    setProjectsExpanded(nextExpanded);
                  }}
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
                  {!lockedWorkspaceCwd && onOpenAddWorkspace && (
                    <button
                      className={styles.projectsHeaderAction}
                      type="button"
                      title={t('sidebar.addWorkspace')}
                      aria-label={t('sidebar.addWorkspace')}
                      onClick={onOpenAddWorkspace}
                    >
                      <PlusIcon />
                    </button>
                  )}
                </div>
              </div>
            )}
            {searchOpen && !hideProjectHeader && (
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
            {projectsExpanded && (
              <>
                <div className={styles.workspacePicker}>
                  <div className={styles.workspaceList}>
                    {projectWorkspaces.map((ws) => (
                      <Fragment key={ws.id}>
                        <WorkspaceSection
                          workspace={ws}
                          renderHeader={
                            lockedWorkspaceCwd && lockedWorkspaceOptions?.render
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
                          sessionCatalogRequestsEnabled={
                            sessionCatalogRequestsEnabled
                          }
                          sessionGroupCatalog={
                            workspaceSessionLiveStateEnabled &&
                            liveStateWorkspaceCwdSet.has(ws.cwd)
                              ? liveStateGroupCatalogs.get(ws.cwd)
                              : undefined
                          }
                          sessionLiveStateEnabled={
                            workspaceSessionLiveStateEnabled &&
                            liveStateWorkspaceCwdSet.has(ws.cwd)
                          }
                          sourceType={selectedSessionSource}
                          channelGroupingEnabled={channelGroupingEnabled}
                          ungroupedLabel={t('sidebar.groupUngrouped')}
                          onRenameGroup={
                            canOrganizeWorkspace(ws.cwd)
                              ? handleRenameGroup
                              : undefined
                          }
                          onDeleteGroup={
                            canOrganizeWorkspace(ws.cwd)
                              ? handleDeleteGroup
                              : undefined
                          }
                          renameGroupLabel={t('sidebar.groupRename')}
                          deleteGroupLabel={t('sidebar.groupDelete')}
                          groupActionsDisabled={groupBusy}
                          excludePinned={selectedSessionSource !== 'channel'}
                          mapSession={applyOptimisticPin}
                          limitSessions={editingSessionIdentity === null}
                          onOpenGitDiff={onOpenGitDiff}
                          onOpenCommit={onOpenCommit}
                          searchQuery={searchQuery}
                          expanded={ws.primary ? projectExpanded : undefined}
                          autoExpandKey={
                            autoExpandWorkspace?.id === ws.id
                              ? autoExpandWorkspace?.key
                              : undefined
                          }
                          onExpandedChange={
                            ws.primary
                              ? (expanded) => {
                                  writeWorkspaceExpanded(
                                    primaryWorkspaceExpansionId,
                                    expanded,
                                  );
                                  setProjectExpanded(expanded);
                                }
                              : undefined
                          }
                          renderSessions={!ws.primary}
                          renderSession={(session) =>
                            renderSessionRow({
                              ...session,
                              workspaceCwd: ws.cwd,
                            })
                          }
                          showSessionDetails={sessionActionItems.has('details')}
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
                                    {canOrganizeWorkspace(ws.cwd) && (
                                      <button
                                        className={styles.workspaceHeaderAction}
                                        type="button"
                                        title={t('sidebar.groupCreate')}
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
                                    )}
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
                                  <SessionMenu
                                    onOpenChange={handleSessionMenuOpenChange}
                                  >
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        className={styles.workspaceHeaderAction}
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
                                    <DropdownMenuContent
                                      align="end"
                                      className="w-auto min-w-40"
                                      style={SESSION_MENU_PORTAL_STYLE}
                                      onPointerDownOutside={
                                        handleSessionMenuPointerDownOutside
                                      }
                                      onCloseAutoFocus={
                                        handleSessionMenuCloseAutoFocus
                                      }
                                    >
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
                                  </SessionMenu>
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
              </>
            )}
            {archivedSection}
          </SidebarSessionSurface>
        </div>

        {(footer !== false || mobileOpen) && (
          <div
            className={cx(
              styles.footer,
              footerCompact && styles.footerCompact,
              footerTight && styles.footerTight,
            )}
          >
            <div className={styles.footerPrimary}>
              {footer && typeof footer === 'object' && footer.render?.()}
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
              {(mobileOpen || footerItems.has('collapse')) && (
                <button
                  className={styles.collapseButton}
                  type="button"
                  title={
                    mobileOpen || !collapsed
                      ? t('sidebar.collapse')
                      : t('sidebar.expand')
                  }
                  aria-label={
                    mobileOpen || !collapsed
                      ? t('sidebar.collapse')
                      : t('sidebar.expand')
                  }
                  onClick={() =>
                    mobileOpen
                      ? onMobileClose?.()
                      : onCollapsedChange(!collapsed)
                  }
                >
                  {collapsed && !mobileOpen ? (
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
    </>
  );
}

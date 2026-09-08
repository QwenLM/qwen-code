/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useActions,
  useConnection,
  useStatusReport,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import type {
  DaemonSessionGroupPresetColor,
  DaemonSessionPrInfo,
  DaemonSessionSummary,
  DaemonStatusReportSession,
  SessionMetadataResult,
} from '@qwen-code/sdk/daemon';
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  CircleIcon,
  CircleHelpIcon,
  InfoIcon,
  ShieldQuestionIcon,
  DownloadIcon,
  FunnelIcon,
  PenLineIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  type ColumnDef,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useI18n } from '../i18n';
import { SessionPrBadge } from './SessionPrBadge';
import { formatRelativeTime } from '../utils/formatRelativeTime';
import { buildSplitUrl, MAX_SPLIT_PANES } from '../utils/splitUrl';
import { workspaceLabel, workspaceLabelForCwd } from '../utils/workspace';
import { useOtherWorkspaceSessions } from '../hooks/useOtherWorkspaceSessions';
import { useScopedSessions } from '../hooks/useScopedSessions';
import { useWorkspaceSessionLiveState } from '../session-catalog/workspace-session-live-state';
import { useSessionCatalogController } from '../session-catalog/session-catalog-hooks';
import { getDaemonToken } from '../config/daemon';
import {
  SESSION_LIST_PAGE_SIZE,
  SESSION_LIVE_STATE_FEATURE,
  SESSION_ORGANIZATION_FEATURE,
} from '../constants/sessions';
import { ErrorBoundary } from './ErrorBoundary';
import { SessionDetailsTooltip } from './sidebar/SessionDetailsTooltip';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Spinner } from './ui/spinner';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  DataTable,
  DataTablePagination,
  type DataTableColumnMeta,
} from './ui/data-table';
import { TooltipProvider } from './ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import styles from './SessionOverviewPanel.module.css';

// The daemon's live-state channel (2s, coordinated through the shared session
// catalog) is the primary refresh path when advertised; the full-list catalog
// poll is only the fallback for daemons without the feature. Full status fans
// out expensive diagnostics, so poll it less often, pause while hidden, and
// never overlap requests.
const LIST_POLL_MS = 3000;
const STATUS_POLL_MS = 10000;
const PAGE_SIZE = 50;
const PAGE_SIZES = [10, 50, 100] as const;
const PAGE_SIZE_STORAGE_KEY = 'qwen-web-shell-session-overview-page-size';

function readPageSize(): number {
  if (typeof window === 'undefined') return PAGE_SIZE;
  try {
    const stored = Number(window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY));
    return stored === 10 || stored === 50 || stored === 100
      ? stored
      : PAGE_SIZE;
  } catch {
    return PAGE_SIZE;
  }
}

function writePageSize(pageSize: number): void {
  try {
    window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

export type SessionCardStatus =
  | 'needsApproval'
  | 'askUserQuestion'
  | 'running'
  | 'idle';

export interface SessionCard {
  sessionId: string;
  label: string;
  status: SessionCardStatus;
  updatedAt?: string;
  color?: DaemonSessionGroupPresetColor | null;
  isCurrent: boolean;
  /** GitHub PRs bound to the session, in binding order (last = latest). */
  prs?: DaemonSessionPrInfo[];
  gitBranch?: string;
  /** The workspace the session lives in. */
  workspaceCwd: string;
}

type SessionStatusFilter = 'all' | 'attention' | 'running' | 'idle';

const STATUS_FILTERS: SessionStatusFilter[] = [
  'all',
  'attention',
  'running',
  'idle',
];

function matchesStatus(
  card: SessionCard,
  filter: SessionStatusFilter,
): boolean {
  return (
    filter === 'all' ||
    (filter === 'attention'
      ? card.status === 'needsApproval' || card.status === 'askUserQuestion'
      : card.status === filter)
  );
}

type SessionIdentity = Pick<SessionCard, 'sessionId' | 'workspaceCwd'>;

function getSessionIdentity(session: SessionIdentity): string {
  return `${session.workspaceCwd}\0${session.sessionId}`;
}

function isCurrentSession(
  session: SessionIdentity,
  currentSessionId: string | undefined,
  currentWorkspaceCwd: string | undefined,
): boolean {
  return (
    session.sessionId === currentSessionId &&
    (!currentWorkspaceCwd || session.workspaceCwd === currentWorkspaceCwd)
  );
}

const STATUS_PRIORITY: Record<SessionCardStatus, number> = {
  needsApproval: 0,
  askUserQuestion: 1,
  running: 2,
  idle: 3,
};

/**
 * Derive the ranked card set from the session list. The volatile live state
 * (`hasActivePrompt`, `isWaitingForPermission`, `isWaitingForUserQuestion`)
 * arrives on the summaries themselves — merged in by the shared session
 * catalog's live-state channel when the daemon advertises it, and carried on
 * plain list responses otherwise. `needsApproval` and `askUserQuestion` are
 * the actionable states (the session is blocked waiting for the user) and take
 * precedence over `running`. Sorted needs-approval → question → running →
 * idle, then most-recent first, so sessions that want attention float to the
 * top of a 10+ session grid.
 */
export function deriveSessionCards(
  sessions: DaemonSessionSummary[],
  currentSessionId: string | undefined,
  statusSessions: DaemonStatusReportSession[] = [],
  currentWorkspaceCwd?: string,
): SessionCard[] {
  const statusByIdentity = new Map(
    statusSessions.map((session) => [getSessionIdentity(session), session]),
  );
  const cards = sessions.map((session): SessionCard => {
    const status = statusByIdentity.get(getSessionIdentity(session));
    const needsApproval =
      session.isWaitingForPermission === true ||
      (status?.pendingPermissionCount ?? 0) > 0;
    const askUserQuestion =
      !needsApproval && session.isWaitingForUserQuestion === true;
    return {
      sessionId: session.sessionId,
      label: session.displayName?.trim() || session.sessionId.slice(0, 8),
      status: needsApproval
        ? 'needsApproval'
        : askUserQuestion
          ? 'askUserQuestion'
          : (session.hasActivePrompt ?? status?.hasActivePrompt)
            ? 'running'
            : 'idle',
      updatedAt: session.updatedAt || session.createdAt,
      color: session.color,
      isCurrent: isCurrentSession(
        session,
        currentSessionId,
        currentWorkspaceCwd,
      ),
      prs: session.prs,
      gitBranch: session.worktree?.branch ?? session.branch?.name,
      workspaceCwd: session.workspaceCwd,
    };
  });
  cards.sort((a, b) => {
    const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (byStatus !== 0) return byStatus;
    // ISO timestamps sort lexicographically; newest first.
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
  return cards;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function colorDotClass(
  color: DaemonSessionGroupPresetColor,
): string | undefined {
  switch (color) {
    case 'red':
      return styles.colorRed;
    case 'orange':
      return styles.colorOrange;
    case 'yellow':
      return styles.colorYellow;
    case 'green':
      return styles.colorGreen;
    case 'blue':
      return styles.colorBlue;
    case 'purple':
      return styles.colorPurple;
    default:
      return undefined;
  }
}

function SessionOverviewPanelInner({
  onOpenSession,
  onOpenSplit,
  onCurrentSessionRemoved,
  includeOtherWorkspaces,
  workspaceCwd,
  manageLiveState,
}: {
  onOpenSession: (sessionId: string, workspaceCwd?: string) => void;
  onOpenSplit?: (sessionIds: string[]) => void;
  onCurrentSessionRemoved?: (
    session: SessionIdentity,
  ) => Promise<boolean | void> | boolean | void;
  includeOtherWorkspaces: boolean;
  workspaceCwd?: string;
  manageLiveState: boolean;
}) {
  const { t } = useI18n();
  const connection = useConnection();
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const workspace = useWorkspace();
  const sessionCatalogController = useSessionCatalogController(
    workspace.client,
  );
  const actions = useActions();
  const currentSessionId = connection.sessionId;
  const organizationEnabled =
    connection.capabilities?.features?.includes(SESSION_ORGANIZATION_FEATURE) ??
    false;
  const sessionMetadataEnabled =
    connection.capabilities?.features?.includes('workspace_session_metadata') ??
    false;
  const sessionArchiveEnabled =
    connection.capabilities?.features?.includes('session_archive') ?? false;
  const workspaceQualifiedRestCoreEnabled =
    connection.capabilities?.features?.includes(
      'workspace_qualified_rest_core',
    ) ?? false;
  const canExportSessions =
    connection.capabilities?.features?.includes('session_export') ?? false;
  const canExportWorkspaceSessions =
    connection.capabilities?.features?.includes('workspace_session_export') ??
    false;
  const registeredWorkspaces =
    connection.capabilities?.workspaces ?? workspace.capabilities?.workspaces;
  const workspaceCatalogAdvertised =
    connection.capabilities?.workspaces !== undefined ||
    workspace.capabilities?.workspaces !== undefined;
  // Prefer the explicitly registered primary. `workspaceCwd` is the legacy
  // single-workspace fallback when the daemon does not advertise a catalog.
  const primaryCwd =
    registeredWorkspaces?.find((entry) => entry.primary)?.cwd ??
    workspace.capabilities?.workspaceCwd ??
    connection.capabilities?.workspaceCwd ??
    connection.workspaceCwd;
  const currentWorkspaceCwd =
    connection.workspaceCwd || workspaceCwd || primaryCwd;

  // Live-state is the sidebar's refresh path: it patches the
  // catalog store's sessions with hasActivePrompt / isWaitingForPermission /
  // isWaitingForUserQuestion and coordinates full-catalog reconciles only when
  // something actually changed. Adopt it only when trusted live-state routes
  // cover every visible workspace; otherwise fall back to catalog polling.
  const liveStateWorkspaceCwds = useMemo(() => {
    if (!workspaceCatalogAdvertised) {
      const legacyCwd = workspaceCwd || primaryCwd;
      return legacyCwd ? [legacyCwd] : [];
    }
    const visible = workspaceCwd
      ? (registeredWorkspaces ?? []).filter(
          (entry) => entry.cwd === workspaceCwd,
        )
      : (registeredWorkspaces ?? []).filter(
          (entry) => entry.primary || entry.trusted,
        );
    return visible.length > 0 && visible.every((entry) => entry.trusted)
      ? visible.map((entry) => entry.cwd)
      : [];
  }, [
    primaryCwd,
    registeredWorkspaces,
    workspaceCatalogAdvertised,
    workspaceCwd,
  ]);
  const liveStateEnabled =
    (connection.capabilities?.features?.includes(SESSION_LIVE_STATE_FEATURE) ??
      false) &&
    liveStateWorkspaceCwds.length > 0;
  // Live state only replaces catalog/status polling when this panel runs the
  // channel itself. When another view owns it, keep the fallback because that
  // view may cover a narrower workspace set.
  const liveStateActive = manageLiveState && liveStateEnabled;
  useWorkspaceSessionLiveState(workspace.client, {
    enabled: liveStateActive,
    pollIntervalMs: workspace.capabilities?.sessionLiveStatePollIntervalMs,
    workspaceCwds: liveStateWorkspaceCwds,
    groupWorkspaceCwds: [],
  });

  const { sessions, loading, error, reload } = useScopedSessions(workspaceCwd, {
    autoLoad: true,
    pollIntervalMs: liveStateActive ? undefined : LIST_POLL_MS,
    pageSize: SESSION_LIST_PAGE_SIZE,
    archiveState: 'active',
    ...(organizationEnabled
      ? { view: 'organized' as const, group: 'all' }
      : {}),
  });
  // Fold in the live sessions of the daemon's other workspaces (empty on a
  // single-workspace daemon), so the overview is mission control for every
  // workspace, not just the primary one.
  const { sessions: otherSessions, reload: reloadOther } =
    useOtherWorkspaceSessions(
      includeOtherWorkspaces && !workspaceCwd,
      liveStateActive ? undefined : LIST_POLL_MS,
    );
  const mergedSessions = useMemo(
    () =>
      otherSessions.length === 0 ? sessions : [...sessions, ...otherSessions],
    [sessions, otherSessions],
  );
  const sessionByIdentity = useMemo(
    () =>
      new Map(
        mergedSessions.map((session) => [getSessionIdentity(session), session]),
      ),
    [mergedSessions],
  );
  const multiWorkspace =
    !workspaceCwd &&
    includeOtherWorkspaces &&
    (registeredWorkspaces?.length ?? 0) > 1;
  const status = useStatusReport({
    autoLoad: !liveStateActive,
    detail: 'full',
  });
  const statusReload = status.reload;
  const statusReport = status.report;

  const statusInFlight = useRef(false);
  useEffect(() => {
    if (liveStateActive) return;
    const timer = window.setInterval(() => {
      if (document.hidden || statusInFlight.current) return;
      statusInFlight.current = true;
      void statusReload().finally(() => {
        statusInFlight.current = false;
      });
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [liveStateActive, statusReload]);

  const cards = useMemo(
    () =>
      deriveSessionCards(
        mergedSessions,
        currentSessionId,
        liveStateActive ? [] : (statusReport?.full?.sessions ?? []),
        currentWorkspaceCwd,
      ),
    [
      mergedSessions,
      currentSessionId,
      currentWorkspaceCwd,
      liveStateActive,
      statusReport,
    ],
  );
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<SessionStatusFilter>('all');
  const [excludedWorkspaceCwds, setExcludedWorkspaceCwds] = useState<
    Set<string>
  >(() => new Set());
  const [workspaceFilterOpen, setWorkspaceFilterOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState<{
    identity: string;
    click: boolean;
  } | null>(null);
  // One replacement owner for every details entry point of this panel, so
  // the focus rescue only fires within the overview.
  const sessionDetailsOwner = useId();
  // Stable column renderers keep the hover anchor mounted as details change.
  const detailsOpenRef = useRef(detailsOpen);
  detailsOpenRef.current = detailsOpen;
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<SessionCard[] | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<SessionCard[] | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [footerSticky, setFooterSticky] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Inline rename state — mirrors the sidebar's double-click/rename flow.
  const [editingCard, setEditingCard] = useState<SessionCard | null>(null);
  const [editingName, setEditingName] = useState('');
  const focusSortAfterRenameRef = useRef(false);
  const editingIdentity = editingCard
    ? getSessionIdentity(editingCard)
    : undefined;
  const isCurrentCard = useCallback(
    (card: SessionCard) => {
      const current = connectionRef.current;
      return isCurrentSession(
        card,
        current.sessionId,
        current.workspaceCwd || workspaceCwd || primaryCwd,
      );
    },
    [primaryCwd, workspaceCwd],
  );

  // Workspace filter options (the primary plus trusted secondaries); hidden
  // when the panel is locked to a single workspace or the daemon has only one.
  const workspaceOptions = useMemo(() => {
    if (workspaceCwd || !multiWorkspace) return [];
    const workspaces = registeredWorkspaces ?? [];
    const listed = workspaces.filter((entry) => entry.primary || entry.trusted);
    return listed.map((entry) => ({
      cwd: entry.cwd,
      label: workspaceLabel(entry),
    }));
  }, [multiWorkspace, registeredWorkspaces, workspaceCwd]);

  // Exclusions are only manageable through the filter popover. When the
  // option set shrinks — most sharply when the host locks the panel to one
  // workspace and the popover disappears — drop any exclusion the user can
  // no longer see or change, so a stale one can't hide every remaining row.
  useEffect(() => {
    if (excludedWorkspaceCwds.size === 0) return;
    // The funnel popover only renders with two or more options; with one or
    // none left, any exclusion is one the user can no longer see or change.
    if (workspaceOptions.length <= 1) {
      setExcludedWorkspaceCwds((prev) =>
        prev.size === 0 ? prev : new Set<string>(),
      );
      return;
    }
    const optionCwds = new Set(workspaceOptions.map((option) => option.cwd));
    setExcludedWorkspaceCwds((prev) => {
      const next = new Set([...prev].filter((cwd) => optionCwds.has(cwd)));
      return next.size === prev.size ? prev : next;
    });
  }, [excludedWorkspaceCwds, workspaceOptions]);

  const searchedCards = useMemo(() => {
    let list = cards;
    if (excludedWorkspaceCwds.size > 0) {
      list = list.filter(
        (card) => !excludedWorkspaceCwds.has(card.workspaceCwd),
      );
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (card) =>
          card.label.toLowerCase().includes(query) ||
          card.sessionId.toLowerCase().includes(query) ||
          card.gitBranch?.toLowerCase().includes(query) ||
          card.prs?.some((pr) => `#${pr.number}`.includes(query)),
      );
    }
    return list;
  }, [cards, excludedWorkspaceCwds, searchQuery]);
  const filteredCards = useMemo(
    () => searchedCards.filter((card) => matchesStatus(card, statusFilter)),
    [searchedCards, statusFilter],
  );
  const sessionDetailsProps = useCallback(
    (card: SessionCard, click = false) => {
      const identity = getSessionIdentity(card);
      return {
        openOnClick: click,
        ownerToken: sessionDetailsOwner,
        open:
          detailsOpenRef.current?.identity === identity &&
          detailsOpenRef.current.click === click,
        onOpenChange: (open: boolean) =>
          setDetailsOpen((current) =>
            open
              ? { identity, click }
              : current?.identity === identity && current.click === click
                ? null
                : current,
          ),
        session: {
          ...sessionByIdentity.get(getSessionIdentity(card)),
          sessionId: card.sessionId,
          workspaceCwd: card.workspaceCwd,
          hasActivePrompt: card.status === 'running',
          isWaitingForPermission: card.status === 'needsApproval',
          isWaitingForUserQuestion: card.status === 'askUserQuestion',
        },
        label: card.label,
        time: card.updatedAt ? formatRelativeTime(card.updatedAt, t) : '',
        completedUnread: false,
      };
    },
    [sessionByIdentity, sessionDetailsOwner, t],
  );

  const isPrimaryCard = useCallback(
    (card: SessionCard) => {
      const workspaceEntry = registeredWorkspaces?.find(
        (entry) => entry.cwd === card.workspaceCwd,
      );
      if (workspaceEntry && !workspaceEntry.trusted) return false;
      if (workspaceEntry?.primary) return true;
      return (
        !workspaceEntry &&
        !workspaceCatalogAdvertised &&
        card.workspaceCwd === primaryCwd
      );
    },
    [primaryCwd, registeredWorkspaces, workspaceCatalogAdvertised],
  );
  const isRegisteredTrustedCard = useCallback(
    (card: SessionCard) =>
      registeredWorkspaces?.some(
        (entry) => entry.cwd === card.workspaceCwd && entry.trusted,
      ) === true,
    [registeredWorkspaces],
  );
  const canUseSessionMutation = useCallback(
    (card: SessionCard) =>
      isPrimaryCard(card) ||
      (isRegisteredTrustedCard(card) && workspaceQualifiedRestCoreEnabled),
    [isPrimaryCard, isRegisteredTrustedCard, workspaceQualifiedRestCoreEnabled],
  );
  const isLockedTrustedCard = useCallback(
    (card: SessionCard) =>
      currentWorkspaceCwd === card.workspaceCwd &&
      isRegisteredTrustedCard(card),
    [currentWorkspaceCwd, isRegisteredTrustedCard],
  );
  const canArchiveCard = useCallback(
    (card: SessionCard) =>
      sessionArchiveEnabled &&
      card.status === 'idle' &&
      canUseSessionMutation(card),
    [canUseSessionMutation, sessionArchiveEnabled],
  );
  const canDeleteCard = useCallback(
    (card: SessionCard) =>
      card.status === 'idle' && canUseSessionMutation(card),
    [canUseSessionMutation],
  );
  const canRenameCard = useCallback(
    (card: SessionCard) =>
      (isCurrentCard(card) &&
        (isPrimaryCard(card) || isLockedTrustedCard(card))) ||
      (sessionMetadataEnabled && canUseSessionMutation(card)),
    [
      canUseSessionMutation,
      isLockedTrustedCard,
      isPrimaryCard,
      isCurrentCard,
      sessionMetadataEnabled,
    ],
  );
  const canExportCard = useCallback(
    (card: SessionCard) =>
      isPrimaryCard(card)
        ? canExportSessions
        : isRegisteredTrustedCard(card) && canExportWorkspaceSessions,
    [
      canExportSessions,
      canExportWorkspaceSessions,
      isPrimaryCard,
      isRegisteredTrustedCard,
    ],
  );

  // Open the selected sessions as a split view in a NEW browser tab: one tab
  // showing all of them side by side (not one tab per session). Passing no
  // window features makes browsers open a tab rather than a popup window.
  const openInNewTab = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    // Carry the (already-stripped-from-the-URL) daemon token so the new tab
    // can authenticate on token-auth deployments.
    const url = buildSplitUrl(
      sessionIds,
      window.location.href,
      getDaemonToken(),
    );
    const win = window.open(url, '_blank');
    if (win) {
      // The split tab carries a daemon token in its URL fragment; sever the
      // opener link so it can't script the shell that spawned it during an
      // authenticated session (reverse tabnabbing). Mirrors the bug-report
      // path.
      win.opener = null;
      win.focus();
    }
    setPopupBlocked(!win);
  }, []);

  const reloadData = useCallback(
    () =>
      Promise.all([
        reload().catch(() => undefined),
        reloadOther().catch(() => undefined),
        liveStateActive
          ? Promise.resolve()
          : statusReload().catch(() => undefined),
      ]),
    [liveStateActive, reload, reloadOther, statusReload],
  );
  const refresh = useCallback(() => {
    if (refreshing) return;
    setActionError(null);
    setRefreshing(true);
    void reloadData().finally(() => setRefreshing(false));
  }, [refreshing, reloadData]);

  // Route each batch through its owning workspace client.
  const mutateCards = useCallback(
    async (cards: SessionCard[], mutation: 'archive' | 'delete') => {
      const canMutate = mutation === 'archive' ? canArchiveCard : canDeleteCard;
      if (!cards.every(canMutate)) {
        throw new Error(t('sessionsOverview.actionUnavailable'));
      }
      const byCwd = new Map<string, SessionCard[]>();
      for (const card of cards) {
        const key =
          !card.workspaceCwd || card.workspaceCwd === primaryCwd
            ? ''
            : card.workspaceCwd;
        byCwd.set(key, [...(byCwd.get(key) ?? []), card]);
      }
      const succeededIdentities = new Set<string>();
      let firstError: Error | undefined;
      for (const [cwd, group] of byCwd) {
        const ids = group.map((card) => card.sessionId);
        const ownerCwd = cwd || primaryCwd;
        try {
          const client = cwd
            ? workspace.client.workspaceByCwd(cwd)
            : workspace.client;
          const cardsById = new Map(
            group.map((card) => [card.sessionId, card]),
          );
          if (mutation === 'archive') {
            const result = await client.archiveSessionsData(ids);
            for (const id of [
              ...result.archived,
              ...result.alreadyArchived,
              ...result.notFound,
            ]) {
              const card = cardsById.get(id);
              if (card) succeededIdentities.add(getSessionIdentity(card));
            }
            firstError ??= result.errors[0]
              ? new Error(result.errors[0].error)
              : undefined;
          } else {
            const result = await client.deleteSessionsData(ids);
            for (const id of [...result.removed, ...result.notFound]) {
              const card = cardsById.get(id);
              if (card) succeededIdentities.add(getSessionIdentity(card));
            }
            firstError ??= result.errors[0]
              ? new Error(result.errors[0].error)
              : undefined;
          }
        } catch (error) {
          firstError ??=
            error instanceof Error ? error : new Error(String(error));
        } finally {
          if (ownerCwd) {
            sessionCatalogController.refreshWorkspace(ownerCwd);
          }
        }
      }
      return { succeededIdentities, error: firstError };
    },
    [
      canArchiveCard,
      canDeleteCard,
      primaryCwd,
      sessionCatalogController,
      t,
      workspace.client,
    ],
  );

  const runBusy = useCallback(
    async (card: SessionCard, operation: () => Promise<void>) => {
      const identity = getSessionIdentity(card);
      setBusyIds((prev) => new Set(prev).add(identity));
      try {
        await operation();
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(identity);
          return next;
        });
      }
    },
    [],
  );

  const startRename = useCallback((card: SessionCard) => {
    setActionError(null);
    setDetailsOpen(null);
    setEditingCard(card);
    setEditingName(card.label);
  }, []);

  const cancelRename = useCallback(() => {
    setEditingCard(null);
    setEditingName('');
  }, []);

  const saveRename = useCallback(() => {
    const card = editingCard;
    const nextName = editingName.trim();
    if (!card || !nextName) {
      cancelRename();
      return;
    }
    if (batchBusy) return;
    if (!canRenameCard(card)) {
      cancelRename();
      setActionError(t('sessionsOverview.actionUnavailable'));
      return;
    }
    if (nextName === card.label) {
      cancelRename();
      return;
    }
    cancelRename();
    void runBusy(card, async () => {
      const ownerCwd = card.workspaceCwd || primaryCwd;
      try {
        // The current session renames through its own session actions (the
        // daemon only allows it there); other sessions update metadata on the
        // owning workspace client — mirroring the sidebar.
        let result: SessionMetadataResult | void;
        if (isCurrentCard(card)) {
          result = await actions.renameSession(nextName);
        } else if (card.workspaceCwd) {
          result = await workspace.client
            .workspaceByCwd(card.workspaceCwd)
            .updateSessionMetadata(card.sessionId, { displayName: nextName });
        } else {
          result = await workspace.client.updateSessionMetadata(
            card.sessionId,
            {
              displayName: nextName,
            },
          );
        }
        if (ownerCwd) {
          sessionCatalogController.renamed(
            ownerCwd,
            card.sessionId,
            result?.displayName || nextName,
          );
          sessionCatalogController.refreshWorkspace(ownerCwd);
        }
        await reloadData();
      } catch (err) {
        if (ownerCwd) {
          sessionCatalogController.refreshWorkspace(ownerCwd);
        }
        setActionError(
          err instanceof Error
            ? `${t('sidebar.renameFailed')}: ${err.message}`
            : t('sidebar.renameFailed'),
        );
      }
    });
  }, [
    actions,
    batchBusy,
    canRenameCard,
    cancelRename,
    editingCard,
    editingName,
    isCurrentCard,
    primaryCwd,
    reloadData,
    runBusy,
    sessionCatalogController,
    t,
    workspace.client,
  ]);
  const editingNameRef = useRef(editingName);
  const saveRenameRef = useRef(saveRename);
  editingNameRef.current = editingName;
  saveRenameRef.current = saveRename;

  // Export the conversation as a downloadable HTML file, mirroring the
  // sidebar's export flow (blob + anchor download).
  const handleExport = useCallback(
    (card: SessionCard) => {
      if (batchBusy) return;
      setActionError(null);
      if (!canExportCard(card)) {
        setActionError(t('sessionsOverview.actionUnavailable'));
        return;
      }
      void runBusy(card, async () => {
        try {
          const result =
            !card.workspaceCwd || card.workspaceCwd === primaryCwd
              ? await workspace.actions.exportSession(card.sessionId, 'html')
              : await workspace.client
                  .workspaceByCwd(card.workspaceCwd)
                  .exportSession(card.sessionId, { format: 'html' });
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
          setActionError(
            err instanceof Error
              ? `${t('sidebar.exportFailed')}: ${err.message}`
              : t('sidebar.exportFailed'),
          );
        }
      });
    },
    [
      batchBusy,
      canExportCard,
      primaryCwd,
      runBusy,
      t,
      workspace.actions,
      workspace.client,
    ],
  );

  const handleBatchArchive = useCallback(
    (cards: SessionCard[]) => {
      if (cards.length === 0 || batchBusy) return;
      setActionError(null);
      setBatchBusy(true);
      void (async () => {
        try {
          const result = await mutateCards(cards, 'archive');
          const current = cards.find(
            (card) =>
              isCurrentCard(card) &&
              result.succeededIdentities.has(getSessionIdentity(card)),
          );
          if (current) {
            const cleared = await onCurrentSessionRemoved?.(current);
            if (cleared === false) {
              setActionError(t('sidebar.newSessionFailed'));
              return;
            }
          }
          if (result.error) throw result.error;
        } catch (err) {
          setActionError(
            err instanceof Error
              ? `${t('sessionsOverview.archiveFailed')}: ${err.message}`
              : t('sessionsOverview.archiveFailed'),
          );
        } finally {
          await reloadData();
          setBatchBusy(false);
        }
      })();
    },
    [
      batchBusy,
      isCurrentCard,
      mutateCards,
      onCurrentSessionRemoved,
      reloadData,
      t,
    ],
  );

  const confirmArchive = useCallback(() => {
    const cards = archiveTarget;
    if (!cards || cards.length === 0) return;
    setArchiveTarget(null);
    handleBatchArchive(cards);
  }, [archiveTarget, handleBatchArchive]);

  const confirmDelete = useCallback(() => {
    const cards = deleteTarget;
    if (!cards || cards.length === 0 || batchBusy) return;
    setDeleteTarget(null);
    setActionError(null);
    setBatchBusy(true);
    void (async () => {
      try {
        const result = await mutateCards(cards, 'delete');
        const current = cards.find(
          (card) =>
            isCurrentCard(card) &&
            result.succeededIdentities.has(getSessionIdentity(card)),
        );
        if (current) {
          const cleared = await onCurrentSessionRemoved?.(current);
          if (cleared === false) {
            setActionError(t('sidebar.newSessionFailed'));
            return;
          }
        }
        if (result.error) throw result.error;
      } catch (err) {
        setActionError(
          err instanceof Error
            ? `${t('sessionsOverview.deleteFailed')}: ${err.message}`
            : t('sessionsOverview.deleteFailed'),
        );
      } finally {
        await reloadData();
        setBatchBusy(false);
      }
    })();
  }, [
    batchBusy,
    deleteTarget,
    isCurrentCard,
    mutateCards,
    onCurrentSessionRemoved,
    reloadData,
    t,
  ]);

  // ── Data table state ──────────────────────────────────────────────────
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>(() => ({
    pageIndex: 0,
    pageSize: readPageSize(),
  }));
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  // User-driven filters reset the view; live status/catalog updates keep the
  // current page and any selections whose session ids still exist.
  useEffect(() => {
    setPagination((prev) =>
      prev.pageIndex === 0 ? prev : { ...prev, pageIndex: 0 },
    );
    setRowSelection({});
    setDetailsOpen(null);
  }, [excludedWorkspaceCwds, searchQuery, statusFilter]);
  useEffect(() => {
    const validIds = new Set(filteredCards.map(getSessionIdentity));
    setRowSelection((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([identity]) => validIds.has(identity)),
      );
      return Object.keys(next).length === Object.keys(prev).length
        ? prev
        : next;
    });
  }, [filteredCards]);
  useEffect(() => {
    setPagination((prev) => {
      const lastPageIndex = Math.max(
        0,
        Math.ceil(filteredCards.length / prev.pageSize) - 1,
      );
      return prev.pageIndex <= lastPageIndex
        ? prev
        : { ...prev, pageIndex: lastPageIndex };
    });
  }, [filteredCards.length]);

  const columns = useMemo<ColumnDef<SessionCard>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllRowsSelected() ||
              (table.getIsSomeRowsSelected() && 'indeterminate')
            }
            onCheckedChange={(value) => table.toggleAllRowsSelected(!!value)}
            aria-label={t('sessionsOverview.selectAll')}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={t('sessionsOverview.selectSession', {
              name: row.original.label,
            })}
          />
        ),
        meta: {
          fixed: 'left',
          width: 40,
          fixedWidth: true,
          stopRowClick: true,
        } satisfies DataTableColumnMeta,
      },
      {
        id: 'title',
        header: t('sessionsOverview.titleColumn'),
        cell: ({ row }) => {
          const card = row.original;
          return (
            <div className="min-w-0 space-y-1 py-1">
              <div className="flex min-w-0 items-center gap-2">
                {card.color && (
                  <span
                    className={cx(styles.colorDot, colorDotClass(card.color))}
                    aria-hidden="true"
                  />
                )}
                {editingIdentity === getSessionIdentity(card) ? (
                  <form
                    className="min-w-0 flex-1"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveRenameRef.current();
                    }}
                  >
                    <Input
                      autoFocus
                      value={editingNameRef.current}
                      onChange={(event) => setEditingName(event.target.value)}
                      onBlur={cancelRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      aria-label={`${t('sidebar.rename')}: ${card.label}`}
                      maxLength={256}
                      className="h-7 w-full text-xs"
                    />
                  </form>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-1 px-1 font-semibold text-current">
                    {card.status !== 'idle' && (
                      <span
                        className={cx('inline-flex shrink-0', styles.attention)}
                        data-web-shell-session-status-cue={card.status}
                        aria-hidden="true"
                        title={t(`sessionsOverview.status.${card.status}`)}
                      >
                        {card.status === 'running' ? (
                          <span className={styles.loading} aria-hidden="true" />
                        ) : card.status === 'needsApproval' ? (
                          <ShieldQuestionIcon
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        ) : (
                          <CircleHelpIcon
                            className="size-3.5"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    )}
                    <SessionDetailsTooltip {...sessionDetailsProps(card)}>
                      <button
                        type="button"
                        className="inline-block w-fit min-w-0 max-w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm leading-5 text-current"
                        data-web-shell-session-title
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            event.detail > 0 &&
                            window.getSelection()?.isCollapsed === false
                          )
                            return;
                          onOpenSession(card.sessionId, card.workspaceCwd);
                        }}
                      >
                        {card.label}
                      </button>
                    </SessionDetailsTooltip>
                    {card.isCurrent && (
                      <Badge
                        variant="secondary"
                        className={cx(
                          'shrink-0 text-[11px]',
                          styles.currentBadge,
                        )}
                      >
                        {t('sessionsOverview.current')}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="max-w-[40%] truncate"
                  data-web-shell-session-workspace
                  title={card.workspaceCwd}
                >
                  {workspaceLabelForCwd(
                    card.workspaceCwd,
                    registeredWorkspaces,
                  )}
                </span>
                {card.gitBranch && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span
                      className="min-w-0 truncate"
                      data-web-shell-session-git
                      title={card.gitBranch}
                    >
                      {card.gitBranch}
                    </span>
                  </>
                )}
                <SessionPrBadge prs={card.prs ?? []} />
              </div>
            </div>
          );
        },
        meta: {
          fixed: 'left',
          fixedEdge: true,
          width: 260,
          fluidWeight: 80,
          truncate: (card) => editingIdentity !== getSessionIdentity(card),
        } satisfies DataTableColumnMeta<SessionCard>,
      },
      {
        id: 'status',
        header: t('sessionsOverview.statusColumn'),
        cell: ({ row }) => {
          const { status } = row.original;
          const StatusIcon =
            status === 'needsApproval'
              ? ShieldQuestionIcon
              : status === 'askUserQuestion'
                ? CircleHelpIcon
                : CircleIcon;
          return (
            <span
              className={cx(
                'inline-flex items-center gap-1.5 text-xs',
                (status === 'needsApproval' || status === 'askUserQuestion') &&
                  styles.attention,
                status === 'idle' && 'text-muted-foreground',
              )}
              data-web-shell-session-status={status}
              title={t(`sessionsOverview.status.${status}`)}
            >
              {status === 'running' ? (
                <span
                  className={styles.loading}
                  data-web-shell-session-loading
                  aria-hidden="true"
                />
              ) : (
                <StatusIcon className="size-3.5" aria-hidden="true" />
              )}
              {t(`sessionsOverview.status.${status}`)}
            </span>
          );
        },
        meta: { width: 144, fluidWeight: 0 } satisfies DataTableColumnMeta,
      },
      {
        id: 'updatedAt',
        accessorFn: (card) => card.updatedAt ?? '',
        header: ({ column }) => (
          <Button
            ref={(button) => {
              // Ending rename recreates the header; focus its new button.
              if (button && focusSortAfterRenameRef.current) {
                focusSortAfterRenameRef.current = false;
                button.focus();
              }
            }}
            type="button"
            variant="ghost"
            size="xs"
            className="px-0 text-sm"
            onClick={() => {
              if (editingIdentity) {
                focusSortAfterRenameRef.current = true;
                cancelRename();
              }
              column.toggleSorting();
            }}
          >
            {t('sessionsOverview.time')}
            <ArrowUpDownIcon className="size-3" />
          </Button>
        ),
        cell: ({ row }) => (
          <span className="block max-w-full truncate text-xs text-current">
            {row.original.updatedAt
              ? formatRelativeTime(row.original.updatedAt, t)
              : ''}
          </span>
        ),
        meta: {
          width: 96,
          fluidWeight: 5,
        } satisfies DataTableColumnMeta,
      },
      {
        id: 'actions',
        header: t('sessionsOverview.actions'),
        cell: ({ row }) => {
          const card = row.original;
          const busy = busyIds.has(getSessionIdentity(card));
          const canArchive = canArchiveCard(card);
          const canDelete = canDeleteCard(card);
          const canRename = canRenameCard(card);
          const canExport = canExportCard(card);
          return (
            <div className="flex items-center justify-center gap-1 [&_button]:cursor-pointer">
              <SessionDetailsTooltip {...sessionDetailsProps(card, true)}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={t('sessionsOverview.details', {
                    name: card.label,
                  })}
                  data-web-shell-session-details
                >
                  <InfoIcon className="size-4" />
                </Button>
              </SessionDetailsTooltip>
              {(isCurrentCard(card) || sessionMetadataEnabled) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={batchBusy || busy || !canRename}
                  onClick={() => startRename(card)}
                  aria-label={t('sidebar.rename')}
                  title={
                    canRename
                      ? t('sidebar.rename')
                      : t('sessionsOverview.actionUnavailable')
                  }
                >
                  <PenLineIcon className="size-4" />
                </Button>
              )}
              {(canExportSessions || canExportWorkspaceSessions) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  disabled={batchBusy || busy || !canExport}
                  onClick={() => handleExport(card)}
                  aria-label={t('sidebar.export')}
                  title={
                    canExport
                      ? t('sidebar.export')
                      : t('sessionsOverview.actionUnavailable')
                  }
                >
                  <DownloadIcon className="size-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                disabled={batchBusy || busy || !canArchive}
                onClick={() => setArchiveTarget([card])}
                aria-label={t('sidebar.archive')}
                title={
                  canArchive
                    ? t('sidebar.archive')
                    : t('sessionsOverview.actionUnavailable')
                }
              >
                <ArchiveIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0 text-destructive hover:text-destructive"
                disabled={batchBusy || busy || !canDelete}
                onClick={() => setDeleteTarget([card])}
                aria-label={t('sidebar.delete')}
                title={
                  canDelete
                    ? t('sidebar.delete')
                    : t('sessionsOverview.actionUnavailable')
                }
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          );
        },
        meta: {
          fixed: 'right',
          fixedEdge: true,
          width: 156,
          fixedWidth: true,
          headerClassName: 'text-center',
          stopRowClick: true,
        } satisfies DataTableColumnMeta,
      },
    ],
    [
      batchBusy,
      busyIds,
      canArchiveCard,
      canDeleteCard,
      canExportCard,
      canExportSessions,
      canExportWorkspaceSessions,
      canRenameCard,
      cancelRename,
      editingIdentity,
      handleExport,
      isCurrentCard,
      onOpenSession,
      registeredWorkspaces,
      sessionMetadataEnabled,
      sessionDetailsProps,
      startRename,
      t,
    ],
  );

  const table = useReactTable({
    data: filteredCards,
    columns,
    state: { sorting, pagination, rowSelection },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: getSessionIdentity,
    autoResetPageIndex: false,
  });
  const visibleRows = table.getRowModel().rows;
  const clampPending =
    pagination.pageIndex > Math.max(0, table.getPageCount() - 1);
  useEffect(() => {
    // A shrinking catalog can leave the page empty until the clamp commits.
    if (clampPending) return;
    if (
      editingIdentity &&
      !visibleRows.some((row) => row.id === editingIdentity)
    ) {
      cancelRename();
    }
    setDetailsOpen((current) =>
      current && !visibleRows.some((row) => row.id === current.identity)
        ? null
        : current,
    );
  }, [visibleRows, clampPending, editingIdentity, cancelRename]);
  const selectedCards = table
    .getSortedRowModel()
    .rows.filter((row) => row.getIsSelected())
    .map((row) => row.original);
  const selectedCount = selectedCards.length;
  const canOpenSelection =
    selectedCount > 0 &&
    selectedCount <= MAX_SPLIT_PANES &&
    selectedCards.every((selected) =>
      cards.every(
        (card) =>
          card.sessionId !== selected.sessionId ||
          card.workspaceCwd === selected.workspaceCwd,
      ),
    );
  const canArchiveSelection =
    selectedCount > 0 && selectedCards.every(canArchiveCard);
  const canDeleteSelection =
    selectedCount > 0 && selectedCards.every(canDeleteCard);
  const splitIds = selectedCards.map((card) => card.sessionId);
  useEffect(() => {
    const panel = panelRef.current;
    const viewport = panel?.parentElement;
    const tableViewport = panel?.querySelector<HTMLElement>(
      '[data-slot="data-table-viewport"]',
    );
    if (
      !panel ||
      !viewport ||
      !tableViewport ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    const update = () => {
      const naturalHeight =
        panel.scrollHeight -
        tableViewport.clientHeight +
        tableViewport.scrollHeight;
      const viewportStyle = getComputedStyle(viewport);
      const viewportContentHeight =
        viewport.clientHeight -
        (Number.parseFloat(viewportStyle.paddingTop) || 0) -
        (Number.parseFloat(viewportStyle.paddingBottom) || 0);
      // Sticky decorations add 13px to the measured height
      // (pt-3 +12, border-t +1). Keep a small hysteresis around the
      // normalized threshold to avoid oscillation.
      setFooterSticky(
        (prev) => naturalHeight > viewportContentHeight + (prev ? 12 : 1),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(viewport);
    observer.observe(tableViewport);
    const table = tableViewport.querySelector('[data-slot="table"]');
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, [filteredCards.length, pagination.pageSize]);

  const workspaceFilterLabel =
    excludedWorkspaceCwds.size === 0
      ? t('sessionsOverview.workspaceAll')
      : t('sessionsOverview.workspacesSelected', {
          count: workspaceOptions.filter(
            (option) => !excludedWorkspaceCwds.has(option.cwd),
          ).length,
          total: workspaceOptions.length,
        });

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-[300px]">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('sessionsOverview.searchPlaceholder')}
          className="h-7 w-full pl-7 text-xs"
          aria-label={t('sessionsOverview.searchPlaceholder')}
        />
      </div>
      {workspaceOptions.length > 1 && (
        <Popover
          open={workspaceFilterOpen}
          onOpenChange={setWorkspaceFilterOpen}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cx(
                'cursor-pointer',
                workspaceOptions.some((option) =>
                  excludedWorkspaceCwds.has(option.cwd),
                ) && 'text-primary',
              )}
              aria-label={`${t('sessionsOverview.workspaceFilter')}: ${workspaceFilterLabel}`}
              title={t('sessionsOverview.workspaceFilter')}
            >
              <FunnelIcon />
              {workspaceFilterLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            sideOffset={2}
            className="w-56 gap-1.5 p-2"
            role="dialog"
            aria-label={t('sessionsOverview.workspaceFilter')}
          >
            <Label
              htmlFor="session-overview-workspace-all"
              className="min-h-7 cursor-pointer gap-2 px-1.5 py-1 text-xs font-normal hover:bg-muted"
            >
              <Checkbox
                id="session-overview-workspace-all"
                checked={
                  workspaceOptions.every(
                    (option) => !excludedWorkspaceCwds.has(option.cwd),
                  ) ||
                  (workspaceOptions.some(
                    (option) => !excludedWorkspaceCwds.has(option.cwd),
                  ) &&
                    'indeterminate')
                }
                onCheckedChange={(checked) =>
                  setExcludedWorkspaceCwds(
                    checked === true
                      ? new Set()
                      : new Set(workspaceOptions.map(({ cwd }) => cwd)),
                  )
                }
              />
              <span>{t('sessionsOverview.allWorkspaces')}</span>
            </Label>
            <div className="max-h-48 overflow-auto rounded-md border bg-muted/50 p-0.5">
              {workspaceOptions.map((option, index) => {
                const id = `session-overview-workspace-${index}`;
                return (
                  <Label
                    key={option.cwd}
                    htmlFor={id}
                    className="min-h-7 cursor-pointer gap-2 px-1.5 py-1 text-xs font-normal hover:bg-muted"
                  >
                    <Checkbox
                      id={id}
                      checked={!excludedWorkspaceCwds.has(option.cwd)}
                      onCheckedChange={(checked) => {
                        setExcludedWorkspaceCwds((current) => {
                          const next = new Set(current);
                          if (checked === true) next.delete(option.cwd);
                          else next.add(option.cwd);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {option.label}
                    </span>
                  </Label>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="ml-auto"
        disabled={refreshing}
        onClick={refresh}
      >
        {refreshing ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <RefreshCwIcon data-icon="inline-start" />
        )}
        {t('sessionsOverview.refresh')}
      </Button>
    </div>
  );

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      data-web-shell-session-panel
      onMouseDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (
          editingCard &&
          event.button === 0 &&
          target.closest('[data-web-shell-session-table-viewport] tr') &&
          !target.closest('input')
        ) {
          event.preventDefault();
        }
      }}
    >
      {/* Search, workspace filter, and manual refresh. */}
      {toolbar}
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label={t('sessionsOverview.statusFilter')}
      >
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter}
            type="button"
            size="sm"
            variant={statusFilter === filter ? 'secondary' : 'ghost'}
            aria-pressed={statusFilter === filter}
            onClick={() => setStatusFilter(filter)}
          >
            {t(`sessionsOverview.filter.${filter}`)}
            <span className="text-xs text-muted-foreground tabular-nums">
              {
                searchedCards.filter((card) => matchesStatus(card, filter))
                  .length
              }
            </span>
          </Button>
        ))}
      </div>

      {popupBlocked && (
        <div className={styles.notice} role="alert">
          {t('sessionsOverview.popupBlocked')}
        </div>
      )}
      {actionError && (
        <div className={styles.notice} role="alert">
          {actionError}
        </div>
      )}
      {error && cards.length > 0 && (
        <div className={styles.notice} role="alert">
          {t('sessionsOverview.loadFailed')}: {error.message}
        </div>
      )}
      <TooltipProvider delayDuration={300}>
        <DataTable
          table={table}
          emptyContent={
            cards.length > 0
              ? t('sessionsOverview.noData')
              : loading
                ? t('sessionsOverview.loading')
                : error
                  ? `${t('sessionsOverview.loadFailed')}: ${error.message}`
                  : t('sessionsOverview.empty')
          }
          className={styles.tableViewport}
          rowClassName="cursor-pointer"
          onRowClick={(row) => {
            if (editingCard || window.getSelection()?.isCollapsed === false)
              return;
            onOpenSession(row.original.sessionId, row.original.workspaceCwd);
          }}
          data-web-shell-session-table-viewport
        />
      </TooltipProvider>

      {filteredCards.length > 0 && (
        <div
          className={cx(
            'flex flex-wrap items-center gap-2',
            footerSticky &&
              'sticky bottom-0 z-30 border-t bg-background pt-3 shadow-[0_16px_0_var(--background)]',
          )}
          data-web-shell-session-footer
        >
          <span className="text-xs text-muted-foreground">
            {t(
              selectedCount > 0
                ? 'sessionsOverview.selectedRows'
                : 'sessionsOverview.sessionCount',
              {
                count: selectedCount,
                total: filteredCards.length,
              },
            )}
          </span>
          {selectedCount > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canArchiveSelection || batchBusy}
                onClick={() => setArchiveTarget(selectedCards)}
                title={t('sessionsOverview.bulkArchiveHint', {
                  count: selectedCount,
                })}
              >
                {t('sessionsOverview.bulkArchive')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canDeleteSelection || batchBusy}
                onClick={() => setDeleteTarget(selectedCards)}
                title={t('sessionsOverview.bulkDeleteHint', {
                  count: selectedCount,
                })}
              >
                {t('sessionsOverview.bulkDelete')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canOpenSelection}
                onClick={() => openInNewTab(splitIds)}
                title={
                  selectedCount > MAX_SPLIT_PANES
                    ? t('sessionsOverview.splitLimit', {
                        max: MAX_SPLIT_PANES,
                      })
                    : t('sessionsOverview.openInTabHint')
                }
              >
                {t('sessionsOverview.openInTab')}
              </Button>
              {onOpenSplit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canOpenSelection}
                  onClick={() => onOpenSplit(splitIds)}
                  title={
                    selectedCount > MAX_SPLIT_PANES
                      ? t('sessionsOverview.splitLimit', {
                          max: MAX_SPLIT_PANES,
                        })
                      : t('sessionsOverview.openInSplitHint')
                  }
                >
                  {t('sessionsOverview.openInSplit')}
                </Button>
              )}
            </div>
          )}
          <DataTablePagination
            table={table}
            pageSizes={PAGE_SIZES}
            labels={{
              rowsPerPage: t('sessionsOverview.rowsPerPage'),
              previous: t('sessionsOverview.previousPage'),
              next: t('sessionsOverview.nextPage'),
              page: (page, total) =>
                t('sessionsOverview.pageInfo', { page, total }),
            }}
            onPageSizeChange={writePageSize}
          />
        </div>
      )}

      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {archiveTarget && archiveTarget.length > 1
                ? t('sessionsOverview.confirmArchiveBulkTitle', {
                    count: archiveTarget.length,
                  })
                : t('sessionsOverview.confirmArchiveTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget && archiveTarget.length > 1
                ? t('sessionsOverview.confirmArchiveBulk', {
                    count: archiveTarget.length,
                  })
                : t('sessionsOverview.confirmArchive', {
                    name: archiveTarget?.[0]?.label ?? '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="disabled:pointer-events-auto disabled:cursor-not-allowed"
              disabled={batchBusy}
              onClick={confirmArchive}
            >
              {t('sidebar.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget && deleteTarget.length > 1
                ? t('sessionsOverview.confirmDeleteBulkTitle', {
                    count: deleteTarget.length,
                  })
                : t('sessionsOverview.confirmDeleteTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.length > 1
                ? t('sessionsOverview.confirmDeleteBulk', {
                    count: deleteTarget.length,
                  })
                : t('sessionsOverview.confirmDelete', {
                    name: deleteTarget?.[0]?.label ?? '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="disabled:pointer-events-auto disabled:cursor-not-allowed"
              disabled={batchBusy}
              onClick={confirmDelete}
            >
              {t('sidebar.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * A malformed daemon payload must not white-screen the shell; contain any
 * render throw to the panel, mirroring DaemonStatusDialog.
 */
export function SessionOverviewPanel({
  onOpenSession,
  onOpenSplit,
  onCurrentSessionRemoved,
  includeOtherWorkspaces = true,
  workspaceCwd,
  manageLiveState = true,
}: {
  onOpenSession: (sessionId: string, workspaceCwd?: string) => void;
  onOpenSplit?: (sessionIds: string[]) => void;
  onCurrentSessionRemoved?: (
    session: SessionIdentity,
  ) => Promise<boolean | void> | boolean | void;
  includeOtherWorkspaces?: boolean;
  workspaceCwd?: string;
  manageLiveState?: boolean;
}) {
  const { t } = useI18n();
  return (
    <ErrorBoundary
      label="session-overview"
      fallback={(fallbackError) => (
        <div className={styles.panel}>
          <div className={styles.empty}>
            {t('sessionsOverview.loadFailed')}: {fallbackError.message}
          </div>
        </div>
      )}
    >
      <SessionOverviewPanelInner
        onOpenSession={onOpenSession}
        onOpenSplit={onOpenSplit}
        onCurrentSessionRemoved={onCurrentSessionRemoved}
        includeOtherWorkspaces={includeOtherWorkspaces}
        workspaceCwd={workspaceCwd}
        manageLiveState={manageLiveState}
      />
    </ErrorBoundary>
  );
}

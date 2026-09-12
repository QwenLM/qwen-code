import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  DaemonClient,
  DaemonSessionGroupCatalog,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonChannelsSnapshot,
  DaemonChannelTypeCatalog,
  DaemonSessionGroup,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import {
  CalendarClockIcon,
  FolderClosedIcon,
  FolderOpenIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatDateTime } from '../../utils/formatDateTime';
import {
  SESSION_LIST_PAGE_SIZE,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
} from '../../constants/sessions';
import {
  readWorkspaceCollapsedGroupIds,
  writeWorkspaceCollapsedGroupIds,
} from './collapsedSessionSections';
import {
  hasWorkspaceExpansionPreference,
  readWorkspaceExpanded,
  writeWorkspaceExpanded,
} from './workspaceExpansion';
import { workspaceLabel } from '../../utils/workspace';
import { SessionGroupSection } from './SessionGroupSection';
import { SessionDetailsTooltip } from './SessionDetailsTooltip';
import {
  mergeSessionContentHits,
  sessionMatchesGitQuery,
} from './sessionSearch';
import { useSessionContentSearch } from './useSessionContentSearch';
import { measureSessionTitleScroll } from './sessionTitleScroll';
import {
  collectScheduledTaskSession,
  type ScheduledTaskSessionSection,
} from './scheduled-task-session-groups';
import { groupSessionsByChannelType } from './channelSessionGroups';
import { useWorkspaceOverview } from './useWorkspaceOverview';
import { WorkspaceDetailsTooltip } from './WorkspaceDetailsTooltip';
import {
  DEFAULT_WORKSPACE_OVERVIEW_ITEMS,
  summarizeSessions,
  type WorkspaceOverviewItem,
  type WorkspaceOverviewSnapshot,
  type WorkspaceSessionStats,
} from './workspaceOverviewModel';
import styles from './WorkspaceSection.module.css';
import sidebarStyles from './WebShellSidebar.module.css';
import { useSessionCatalogQuery } from '../../session-catalog/session-catalog-hooks';
import type { SessionCatalogQuery } from '../../session-catalog/session-catalog-store';

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

// The cwd-qualified daemon route only accepts a workspace id or absolute path.
// A synthetic fallback workspace (daemon reports no workspaces and the
// connection has no cwd) carries a display name in `cwd`, which is neither, so
// qualifying a request with it would only ever 400.
export function isAbsolutePath(cwd: string): boolean {
  return (
    cwd.startsWith('/') || cwd.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(cwd)
  );
}

function getSessionLabel(session: DaemonSessionSummary): string {
  const displayName = session.displayName?.trim();
  return displayName || session.sessionId.slice(0, 8);
}

function WorkspaceFolderIcon({ open }: { open: boolean }) {
  const Icon = open ? FolderOpenIcon : FolderClosedIcon;
  return (
    <Icon
      className={styles.folderIcon}
      size={14}
      strokeWidth={1.4}
      aria-hidden="true"
    />
  );
}

export interface WorkspaceHeaderActionsContext {
  overview: WorkspaceOverviewSnapshot | undefined;
  /** Current branch from the git poll; null/undefined when not a git repo or not polled. */
  gitBranch: string | null | undefined;
}

interface WorkspaceSectionProps {
  workspace: DaemonWorkspaceCapability;
  renderHeader?: (expanded: boolean) => ReactNode;
  client: DaemonClient;
  reloadToken: number;
  untrustedLabel: string;
  readOnlyLabel: string;
  trustToOpenLabel: string;
  noSessionsLabel: string;
  loadErrorLabel: string;
  organizationEnabled: boolean;
  sessionCatalogRequestsEnabled?: boolean;
  sessionGroupCatalog?: DaemonSessionGroupCatalog;
  sessionLiveStateEnabled?: boolean;
  sourceType?: string;
  channelGroupingEnabled?: boolean;
  ungroupedLabel: string;
  searchQuery?: string;
  expanded?: boolean;
  autoExpandKey?: string;
  onExpandedChange?: (expanded: boolean) => void;
  renderSessions?: boolean;
  /**
   * Render one session row. The sidebar passes its shared `renderSessionRow`
   * so per-workspace sessions match the single-workspace list exactly — same
   * type scale, hover actions (pin, archive, export, more…), and states —
   * instead of a bespoke, feature-poor row. `options.searchSnippet` carries
   * the content-search excerpt for sessions matched on message text.
   */
  renderSession: (
    session: DaemonSessionSummary,
    options?: { searchSnippet?: string | undefined },
  ) => ReactNode;
  mapSession?: (session: DaemonSessionSummary) => DaemonSessionSummary;
  showSessionDetails?: boolean;
  /**
   * Hover-revealed actions at the right edge of the folder header. Receives
   * the workspace's overview snapshot — undefined until the first fetch or
   * when the overview is disabled; the last fetched one while its consumers
   * are closed — so a menu can show counts, and the polled git branch
   * so git-only actions can be withheld from non-git workspaces.
   */
  headerActions?: (
    visible: boolean,
    context: WorkspaceHeaderActionsContext,
  ) => ReactNode;
  /**
   * Show a details popover on hover with the full path, git branch, session
   * counts and facet counts (MCP, skills, …). Off by default so embedders
   * that render their own header keep today's layout. Facets are fetched
   * only while the details or header menu is open and the workspace is trusted.
   */
  overviewEnabled?: boolean;
  overviewItems?: readonly WorkspaceOverviewItem[];
  /** Whether the header menu is consuming workspace metadata. */
  overviewMenuOpen?: boolean;
  /**
   * A header action reads the polled git branch (the worktree entry), so the
   * poll runs while the menu is open. Off when no consumer
   * of `gitBranch` is wired.
   */
  gitBranchWanted?: boolean;
  /**
   * Session counts for the hover popover. The primary workspace's sessions
   * are listed by the sidebar itself, so it passes them in; other workspaces
   * count their own catalog page. `null` means the parent owns the counts
   * but has no page yet (a source switch in flight): show none rather than
   * the previous source's numbers.
   */
  sessionStats?: WorkspaceSessionStats | null;
  onRenameGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  onDeleteGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  renameGroupLabel?: string;
  deleteGroupLabel?: string;
  groupActionsDisabled?: boolean;
  excludePinned?: boolean;
  limitSessions?: boolean;
  /**
   * Whether the sidebar-level Pinned section renders this session. Pinned
   * rows have one owner: a pinned content-search ghost is kept in this
   * list only when the Pinned section does not carry it.
   */
  isPinnedSectionMember?: (session: DaemonSessionSummary) => boolean;
  /**
   * Open the workspace folder in the daemon host's file manager. Wired only
   * when the daemon advertises `workspace_local_open` and the client is on
   * the same machine; the hover popover's path row shows the button then.
   */
  onOpenPathLocally?: (cwd: string) => Promise<void>;
  /**
   * Open a terminal at the workspace path on the daemon host. Wired only
   * when the daemon advertises `workspace_local_terminal` and the client is
   * on the same machine.
   */
  onOpenTerminalLocally?: (cwd: string) => Promise<void>;
}

export function WorkspaceSection({
  workspace,
  renderHeader,
  client,
  reloadToken,
  untrustedLabel,
  readOnlyLabel,
  trustToOpenLabel,
  noSessionsLabel,
  loadErrorLabel,
  organizationEnabled,
  sessionCatalogRequestsEnabled = true,
  sessionGroupCatalog,
  sessionLiveStateEnabled = false,
  sourceType,
  channelGroupingEnabled = false,
  ungroupedLabel,
  searchQuery = '',
  expanded: controlledExpanded,
  autoExpandKey,
  onExpandedChange,
  renderSessions = true,
  renderSession,
  mapSession,
  showSessionDetails = true,
  headerActions,
  overviewEnabled = false,
  overviewMenuOpen = false,
  overviewItems = DEFAULT_WORKSPACE_OVERVIEW_ITEMS,
  gitBranchWanted = false,
  sessionStats,
  onRenameGroup,
  onDeleteGroup,
  renameGroupLabel,
  deleteGroupLabel,
  groupActionsDisabled,
  excludePinned = false,
  limitSessions = true,
  isPinnedSectionMember,
  onOpenPathLocally,
  onOpenTerminalLocally,
}: WorkspaceSectionProps) {
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [channelCatalog, setChannelCatalog] = useState<{
    catalog: DaemonChannelTypeCatalog;
    snapshot: DaemonChannelsSnapshot;
  }>();
  const [internalExpanded, setInternalExpanded] = useState(() =>
    readWorkspaceExpanded(workspace.id),
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() =>
    readWorkspaceCollapsedGroupIds(workspace.id),
  );
  const [actionsVisible, setActionsVisible] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [gitStatus, setGitStatus] = useState<DaemonWorkspaceGitStatus>();
  const channelCatalogLoadRequestId = useRef(0);
  const { t } = useI18n();
  const expanded = controlledExpanded ?? internalExpanded;
  const readOnly = !workspace.primary && !workspace.trusted;
  const disabled = workspace.primary && !workspace.trusted;
  const searchActive = searchQuery.trim().length > 0;

  // Uncontrolled workspace rows restore the user's last choice.
  useEffect(() => {
    if (controlledExpanded === undefined) {
      setInternalExpanded(readWorkspaceExpanded(workspace.id));
    }
  }, [controlledExpanded, workspace.id]);

  useEffect(() => {
    // The five-row preview is scoped per source; reset the one-shot
    // show-all when the section collapses or the source changes.
    setShowAllSessions(false);
  }, [expanded, sourceType]);

  // The render site keys this component by workspace id, so an id change
  // always remounts and the lazy useState initializer re-reads storage.
  useEffect(() => {
    writeWorkspaceCollapsedGroupIds(workspace.id, collapsedGroupIds);
  }, [collapsedGroupIds, workspace.id]);

  useEffect(() => {
    if (
      controlledExpanded === undefined &&
      autoExpandKey &&
      !hasWorkspaceExpansionPreference(workspace.id)
    ) {
      setInternalExpanded(true);
    }
  }, [autoExpandKey, controlledExpanded, workspace.id]);

  const sessionsEnabled = renderSessions && !disabled;
  const sessionsVisible = expanded || Boolean(searchQuery.trim());
  const sessionsQuery = useMemo<SessionCatalogQuery>(
    () => ({
      routeKind: 'qualified',
      workspaceCwd: workspace.cwd,
      options: {
        pageSize: SESSION_LIST_PAGE_SIZE,
        archiveState: 'active',
        ...(sourceType ? { sourceType } : {}),
        ...(organizationEnabled
          ? { view: 'organized' as const, group: 'all' }
          : {}),
      },
    }),
    [organizationEnabled, sourceType, workspace.cwd],
  );
  const sessionsResult = useSessionCatalogQuery(client, sessionsQuery, {
    autoLoad: sessionCatalogRequestsEnabled && !sessionLiveStateEnabled,
    enabled: sessionsEnabled && sessionsVisible,
    ...(sessionCatalogRequestsEnabled &&
    sessionsVisible &&
    !readOnly &&
    !sessionLiveStateEnabled
      ? { pollIntervalMs: 10_000 }
      : {}),
  });
  const {
    page: sessionsPage,
    reload: reloadSessions,
    stale: sessionsStale,
    loading: sessionsLoading,
  } = sessionsResult;
  const sessionsActive = sessionsEnabled && sessionsVisible;
  const previousSessionsActiveRef = useRef(sessionsActive);
  const previousReadOnlyRef = useRef(readOnly);
  useEffect(() => {
    const wasActive = previousSessionsActiveRef.current;
    const wasReadOnly = previousReadOnlyRef.current;
    previousSessionsActiveRef.current = sessionsActive;
    previousReadOnlyRef.current = readOnly;
    if (
      sessionCatalogRequestsEnabled &&
      !sessionLiveStateEnabled &&
      sessionsActive &&
      (!wasActive || wasReadOnly !== readOnly) &&
      sessionsPage &&
      !sessionsStale
    ) {
      void reloadSessions().catch(() => undefined);
    }
  }, [
    readOnly,
    reloadSessions,
    sessionCatalogRequestsEnabled,
    sessionLiveStateEnabled,
    sessionsActive,
    sessionsPage,
    sessionsStale,
  ]);
  const sessions = sessionsResult.sessions;
  const loadError = Boolean(sessionsResult.error);

  useEffect(() => {
    if (!sessionsResult.error) return;
    console.warn(
      `[WorkspaceSection] session poll failed for ${workspace.cwd}:`,
      sessionsResult.error,
    );
  }, [sessionsResult.error, workspace.cwd]);

  useEffect(() => {
    if (
      !renderSessions ||
      disabled ||
      !organizationEnabled ||
      channelGroupingEnabled
    ) {
      setGroups([]);
      return;
    }
    if (!sessionCatalogRequestsEnabled) return;
    if (sessionLiveStateEnabled) {
      // Live-state owns group freshness here; while its catalog is pending
      // there is no valid group data, so clear rather than render stale.
      setGroups(sessionGroupCatalog?.groups ?? []);
      return;
    }
    let cancelled = false;
    void client
      .workspaceByCwd(workspace.cwd)
      .listSessionGroups()
      .then((catalog) => {
        if (!cancelled) setGroups(catalog.groups);
      })
      .catch((err: unknown) => {
        console.warn('[WorkspaceSection] group catalog load failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [
    channelGroupingEnabled,
    client,
    disabled,
    organizationEnabled,
    reloadToken,
    renderSessions,
    sessionCatalogRequestsEnabled,
    sessionGroupCatalog,
    sessionLiveStateEnabled,
    workspace.cwd,
  ]);

  const loadChannelCatalog = useCallback(async () => {
    if (disabled || readOnly || !channelGroupingEnabled) return;
    const requestId = ++channelCatalogLoadRequestId.current;
    try {
      const workspaceClient = client.workspaceByCwd(workspace.cwd);
      const [catalog, snapshot] = await Promise.all([
        workspaceClient.workspaceChannelTypes(),
        workspaceClient.workspaceChannels(),
      ]);
      if (requestId === channelCatalogLoadRequestId.current) {
        setChannelCatalog({ catalog, snapshot });
      }
    } catch (err) {
      // Keep the last known catalog across a transient failure; the next
      // poll tick retries.
      console.warn('[WorkspaceSection] channel catalog load failed:', err);
    }
  }, [channelGroupingEnabled, client, disabled, readOnly, workspace.cwd]);

  useEffect(() => {
    if (!renderSessions || disabled || readOnly || !channelGroupingEnabled) {
      channelCatalogLoadRequestId.current += 1;
      setChannelCatalog(undefined);
      return;
    }
    if (!expanded && !searchActive) return;
    void loadChannelCatalog();
    // The catalog rides its own tick so instances added or removed while a
    // section is expanded reach the grouping logic without a collapse cycle.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void loadChannelCatalog();
    }, 10_000);
    return () => clearInterval(timer);
  }, [
    channelGroupingEnabled,
    disabled,
    expanded,
    loadChannelCatalog,
    readOnly,
    reloadToken,
    renderSessions,
    searchActive,
  ]);

  // Undefined when `cwd` is not a real path (synthetic fallback workspace), so
  // the poll — which qualifies the route with the cwd — is skipped entirely.
  const gitPollCwd = isAbsolutePath(workspace.cwd) ? workspace.cwd : undefined;
  const gitStatusEnabled =
    (overviewEnabled && detailsOpen) || (gitBranchWanted && overviewMenuOpen);

  // Log a poll failure only on the success→failure transition, not on every
  // 60s/focus tick, so an unreachable workspace doesn't spam a long-lived tab.
  const gitPollFailed = useRef(false);
  const gitPollGeneration = useRef(0);
  // In-flight reads are discarded only when the poll target changes. A
  // consumer closing keeps the read alive so its snapshot is retained for the
  // next open instead of being thrown away mid-flight.
  const gitPollTargetRef = useRef<
    | {
        client: DaemonClient;
        cwd: string | undefined;
        trusted: boolean;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    gitPollTargetRef.current = {
      client,
      cwd: gitPollCwd,
      trusted: workspace.trusted,
    };
  }, [client, gitPollCwd, workspace.trusted]);
  const loadGitStatus = useCallback(async () => {
    if (!gitStatusEnabled || !workspace.trusted || !gitPollCwd) return;
    const generation = ++gitPollGeneration.current;
    const target = { client, cwd: gitPollCwd, trusted: workspace.trusted };
    const isCurrent = () => {
      const latest = gitPollTargetRef.current;
      return (
        generation === gitPollGeneration.current &&
        latest?.client === target.client &&
        latest?.cwd === target.cwd &&
        latest?.trusted === target.trusted
      );
    };
    try {
      // wait: the hover summary shows the enriched counters and has no SSE
      // fill-in path, so it keeps the blocking semantics instead of the
      // composer's last-known fast path.
      const status = await client
        .workspaceByCwd(gitPollCwd)
        .workspaceGit({ wait: true });
      if (!isCurrent()) return;
      gitPollFailed.current = false;
      setGitStatus(status);
    } catch (err) {
      if (!isCurrent()) return;
      // Keep the last known status on a transient failure so a brief network
      // or daemon blip doesn't blank the summary for a whole poll interval; log
      // only on the success→failure transition.
      if (!gitPollFailed.current) {
        console.warn('[WorkspaceSection] git status poll failed:', err);
        gitPollFailed.current = true;
      }
    }
  }, [client, gitPollCwd, gitStatusEnabled, workspace.trusted]);

  // Poll only while the hover summary or a Git-dependent menu is visible.
  useEffect(() => {
    if (!workspace.trusted || !gitPollCwd) {
      setGitStatus(undefined);
      return;
    }
    if (!gitStatusEnabled) return;
    void loadGitStatus();
    const onFocus = () => void loadGitStatus();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadGitStatus();
    }, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [
    gitPollCwd,
    gitStatusEnabled,
    loadGitStatus,
    reloadToken,
    workspace.trusted,
  ]);

  // The hover details popover under the default header and the header
  // actions (the menu's live counts) are the snapshot's consumers; a custom
  // header without wired actions fetches nothing.
  const overviewConsumed =
    overviewEnabled &&
    !disabled &&
    ((!renderHeader && detailsOpen) ||
      (Boolean(headerActions) && overviewMenuOpen));
  const { overview } = useWorkspaceOverview(client, gitPollCwd, {
    enabled: overviewConsumed && workspace.trusted,
    items: overviewItems,
    reloadToken,
  });
  // Keep the last snapshot while consumers are closed so reopening can show
  // counts before the fresh read completes.
  const [retainedOverview, setRetainedOverview] =
    useState<WorkspaceOverviewSnapshot>();
  useEffect(() => {
    if (overview) setRetainedOverview(overview);
  }, [overview]);
  const liveStats = useMemo<WorkspaceSessionStats | undefined>(() => {
    if (!overviewEnabled) return undefined;
    if (sessionStats) return sessionStats;
    if (!sessionsEnabled || sessionsPage === undefined) return undefined;
    return summarizeSessions(
      sessions,
      // Either more pages follow, or the daemon capped its scan and marked
      // the page a lower bound.
      Boolean(sessionsResult.nextCursor) || sessionsResult.truncated === true,
    );
  }, [
    overviewEnabled,
    sessionStats,
    sessions,
    sessionsEnabled,
    sessionsPage,
    sessionsResult.nextCursor,
    sessionsResult.truncated,
  ]);
  // Collapsing a row disables its catalog query, so keep the last counts the
  // row computed: the hover popover keeps telling how busy the workspace is
  // without paying for a subscription it no longer lists. While the query is
  // active
  // a missing page is a fetch in progress (a source switch swapped the query
  // key), and stale counts above an empty list would mislead — show none.
  // The retained value is tagged with the source it was computed for: a
  // global source switch while the row is collapsed must not keep showing
  // the previous source's numbers.
  const [retained, setRetained] = useState<{
    stats: WorkspaceSessionStats;
    sourceType: string | undefined;
  }>();
  useEffect(() => {
    if (liveStats) setRetained({ stats: liveStats, sourceType });
  }, [liveStats, sourceType]);
  const retainedStats =
    retained && retained.sourceType === sourceType ? retained.stats : undefined;
  const stats =
    overviewEnabled && sessionStats !== null
      ? (liveStats ?? (sessionsActive ? undefined : retainedStats))
      : undefined;

  // Order-insensitive membership key: poll-driven catalog updates change
  // it only when the session-id set actually changes, so externally
  // deleted/archived sessions invalidate content-search hits the same way
  // local-handler token bumps do (without re-firing on every poll tick).
  const sessionMembershipKey = useMemo(
    () =>
      sessions
        .map((session) => session.sessionId)
        .sort()
        .join('|'),
    [sessions],
  );
  const contentSearchHits = useSessionContentSearch(
    sessionsEnabled ? client : undefined,
    workspace.cwd,
    searchQuery,
    `${reloadToken}:${sessionMembershipKey}`,
  );
  const searchedSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const scoped = sessions.map((session) => mapSession?.(session) ?? session);
    if (!query) return scoped;
    const localMatches = scoped.filter((session) => {
      const label = (session.displayName || '').toLowerCase();
      return (
        label.includes(query) ||
        session.sessionId.toLowerCase().includes(query) ||
        sessionMatchesGitQuery(session, query)
      );
    });
    // Merge daemon transcript-content hits into the local fast-path
    // matches (shared with WebShellSidebar's copy — see sessionSearch).
    return mergeSessionContentHits(
      scoped,
      localMatches,
      contentSearchHits,
      sourceType,
      mapSession,
    );
  }, [contentSearchHits, mapSession, searchQuery, sessions, sourceType]);
  const renderSessionWithSnippet = (session: DaemonSessionSummary) =>
    renderSession(session, {
      // Explicit options override renderSessionRow's guarded default, so
      // gate the lookup on an active query the same way.
      searchSnippet: searchQuery.trim()
        ? contentSearchHits.get(session.sessionId)?.snippet
        : undefined,
    });
  const visibleSessions = useMemo(() => {
    if (!excludePinned) return searchedSessions;
    // A pinned content-search hit the loaded catalog doesn't carry must
    // stay visible: loaded pinned rows render via their Pinned section /
    // group buckets, but that path never sees ghost hits (R2-2). Unless
    // the Pinned section DOES carry it — pinned rows have one owner (R4-1).
    const catalogIds = new Set(sessions.map((session) => session.sessionId));
    return searchedSessions.filter(
      (session) =>
        !session.isPinned ||
        (contentSearchHits.has(session.sessionId) &&
          !catalogIds.has(session.sessionId) &&
          !isPinnedSectionMember?.(session)),
    );
  }, [
    contentSearchHits,
    excludePinned,
    isPinnedSectionMember,
    searchedSessions,
    sessions,
  ]);
  const directSessions =
    searchActive || showAllSessions || !limitSessions
      ? visibleSessions
      : visibleSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT);

  const groupedSessions = useMemo(() => {
    // The grouped branch has no trust gate of its own; untrusted secondary
    // workspaces keep the flat branch's read-only "trust to open" rows.
    if (channelGroupingEnabled || readOnly) return null;
    const assigned = new Set<string>();
    const sections = organizationEnabled
      ? groups.map((group) => {
          // Group sections derive from the search-filtered list, not the
          // pinned-filtered one: pinned members are lifted into the Pinned
          // section, but dropping them here rendered a group whose members are
          // all pinned as `· 0`, indistinguishable from lost memberships
          // (#10391).
          const items = searchedSessions.filter(
            (session) => session.groupId === group.id,
          );
          items.forEach((session) => assigned.add(session.sessionId));
          return { group, sessions: items };
        })
      : [];
    const scheduledSections = new Map<string, ScheduledTaskSessionSection>();
    for (const session of searchedSessions) {
      if (assigned.has(session.sessionId)) continue;
      if (collectScheduledTaskSession(scheduledSections, session)) {
        assigned.add(session.sessionId);
      }
    }
    if (sections.length === 0 && scheduledSections.size === 0) return null;
    return {
      sections,
      scheduledSections: [...scheduledSections.values()],
      // Pinned sessions without a group stay Pinned-section-only; they never
      // spill into Ungrouped.
      ungrouped: visibleSessions.filter(
        (session) => !assigned.has(session.sessionId),
      ),
    };
  }, [
    channelGroupingEnabled,
    groups,
    organizationEnabled,
    readOnly,
    searchedSessions,
    visibleSessions,
  ]);

  const channelSessionGroups = useMemo(
    () =>
      channelGroupingEnabled && channelCatalog
        ? groupSessionsByChannelType(
            visibleSessions,
            channelCatalog.catalog,
            channelCatalog.snapshot.instances,
            t('sidebar.channelType.other'),
          )
        : null,
    [channelCatalog, channelGroupingEnabled, t, visibleSessions],
  );

  const toggleExpanded = () => {
    if (disabled) return;
    const nextExpanded = !expanded;
    setInternalExpanded(nextExpanded);
    if (controlledExpanded === undefined) {
      writeWorkspaceExpanded(workspace.id, nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  };

  const headerRow = (
    <div
      className={cx(styles.headerRow, disabled && styles.headerDisabled)}
      onClick={(event) => {
        if (event.target === event.currentTarget) toggleExpanded();
      }}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseLeave={() => setActionsVisible(false)}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setActionsVisible(false);
        }
      }}
    >
      <button
        className={styles.header}
        type="button"
        disabled={disabled}
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        {renderHeader ? (
          renderHeader(expanded)
        ) : (
          <>
            <span
              className={cx(styles.chevron, expanded && styles.chevronOpen)}
            >
              <WorkspaceFolderIcon open={expanded} />
            </span>
            <span className={styles.headerContent}>
              <span className={styles.name} title={workspace.cwd}>
                {workspaceLabel(workspace)}
              </span>
            </span>
            {!workspace.trusted && (
              <span className={styles.badge}>{untrustedLabel}</span>
            )}
            {readOnly && <span className={styles.badge}>{readOnlyLabel}</span>}
          </>
        )}
      </button>
      {headerActions?.(actionsVisible, {
        overview: overview ?? retainedOverview,
        gitBranch: gitStatus?.branch,
      })}
    </div>
  );
  return (
    <div className={styles.section}>
      {overviewEnabled && !renderHeader && !disabled ? (
        <WorkspaceDetailsTooltip
          label={workspaceLabel(workspace)}
          cwd={gitPollCwd}
          branch={gitStatus?.branch}
          gitStatus={gitStatus}
          sessions={stats}
          overview={overview ?? retainedOverview}
          items={overviewItems}
          onOpenChange={setDetailsOpen}
          onOpenPathLocally={
            onOpenPathLocally && gitPollCwd && workspace.trusted
              ? () => onOpenPathLocally(workspace.cwd)
              : undefined
          }
          onOpenTerminalLocally={
            onOpenTerminalLocally && gitPollCwd && workspace.trusted
              ? () => onOpenTerminalLocally(workspace.cwd)
              : undefined
          }
        >
          {headerRow}
        </WorkspaceDetailsTooltip>
      ) : (
        headerRow
      )}
      {renderSessions &&
        (expanded || Boolean(searchQuery.trim())) &&
        !disabled && (
          <div className={styles.sessions}>
            {loadError ? (
              <div className={styles.error} role="status">
                {loadErrorLabel}
              </div>
            ) : visibleSessions.length === 0 &&
              // Group sections keep pinned members even when the
              // pinned-filtered list is empty, so only show the empty label
              // when the grouped view has nothing to render either.
              !(
                groupedSessions &&
                (groupedSessions.sections.some(
                  (section) => section.sessions.length > 0,
                ) ||
                  groupedSessions.scheduledSections.some(
                    (section) => section.sessions.length > 0,
                  ))
              ) ? (
              // A source switch swaps the query key; until the new source's
              // page settles there is no data yet, so the "no sessions" notice
              // would flash for a whole fetch round-trip.
              sessionsLoading && sessionsPage === undefined ? null : (
                <div className={styles.empty}>{noSessionsLabel}</div>
              )
            ) : channelSessionGroups ? (
              <>
                {channelSessionGroups.map((group) => (
                  <SessionGroupSection
                    id={group.id}
                    key={group.id}
                    label={group.label}
                    count={group.sessions.length}
                    limitSessions={limitSessions && !searchActive}
                    expanded={!collapsedGroupIds.has(group.id)}
                    onToggle={() => {
                      setCollapsedGroupIds((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      });
                    }}
                  >
                    {group.sessions.map((session) =>
                      renderSessionWithSnippet(session),
                    )}
                  </SessionGroupSection>
                ))}
              </>
            ) : groupedSessions && !channelGroupingEnabled ? (
              <>
                {groupedSessions.sections.map(({ group, sessions }) => (
                  <SessionGroupSection
                    id={`group:${group.id}`}
                    key={`${group.id}:${sourceType ?? ''}`}
                    label={group.name}
                    count={sessions.length}
                    limitSessions={limitSessions && !searchActive}
                    color={group.color}
                    expanded={!collapsedGroupIds.has(group.id)}
                    onToggle={() => {
                      setCollapsedGroupIds((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      });
                    }}
                    onRename={
                      onRenameGroup
                        ? () => onRenameGroup(group, workspace.cwd)
                        : undefined
                    }
                    onDelete={
                      onDeleteGroup
                        ? () => onDeleteGroup(group, workspace.cwd)
                        : undefined
                    }
                    renameLabel={renameGroupLabel}
                    deleteLabel={deleteGroupLabel}
                    actionsDisabled={groupActionsDisabled}
                  >
                    {sessions.map((session) =>
                      renderSessionWithSnippet(session),
                    )}
                  </SessionGroupSection>
                ))}
                {groupedSessions.scheduledSections.map((section) => (
                  <SessionGroupSection
                    id={section.id}
                    key={`${section.id}:${sourceType ?? ''}`}
                    label={section.label}
                    count={section.sessions.length}
                    limitSessions={limitSessions && !searchActive}
                    icon={
                      <CalendarClockIcon data-web-shell-scheduled-task-group />
                    }
                    expanded={!collapsedGroupIds.has(section.id)}
                    onToggle={() => {
                      setCollapsedGroupIds((current) => {
                        const next = new Set(current);
                        if (next.has(section.id)) next.delete(section.id);
                        else next.add(section.id);
                        return next;
                      });
                    }}
                  >
                    {section.sessions.map((session) => renderSession(session))}
                  </SessionGroupSection>
                ))}
                {groupedSessions.ungrouped.length > 0 && (
                  <SessionGroupSection
                    key={`ungrouped:${sourceType ?? ''}`}
                    id="ungrouped"
                    label={ungroupedLabel}
                    count={groupedSessions.ungrouped.length}
                    limitSessions={limitSessions && !searchActive}
                    expanded={!collapsedGroupIds.has('ungrouped')}
                    onToggle={() => {
                      setCollapsedGroupIds((current) => {
                        const next = new Set(current);
                        if (next.has('ungrouped')) next.delete('ungrouped');
                        else next.add('ungrouped');
                        return next;
                      });
                    }}
                  >
                    {groupedSessions.ungrouped.map((session) =>
                      renderSessionWithSnippet(session),
                    )}
                  </SessionGroupSection>
                )}
              </>
            ) : (
              <>
                {directSessions.map((session) => {
                  if (!readOnly) return renderSessionWithSnippet(session);
                  const label = getSessionLabel(session);
                  const stamp = session.updatedAt || session.createdAt;
                  const row = (
                    <div
                      key={session.sessionId}
                      className={styles.sessionItemReadOnly}
                      role="note"
                      aria-label={`${label}. ${trustToOpenLabel}`}
                      onMouseEnter={(event) =>
                        measureSessionTitleScroll(event.currentTarget)
                      }
                    >
                      <span
                        className={styles.sessionName}
                        data-web-shell-session-title
                      >
                        <span className={styles.sessionNameInner}>{label}</span>
                      </span>
                    </div>
                  );
                  return showSessionDetails ? (
                    <SessionDetailsTooltip
                      key={session.sessionId}
                      session={session}
                      label={label}
                      time={stamp ? formatDateTime(stamp) : ''}
                      completedUnread={false}
                    >
                      {row}
                    </SessionDetailsTooltip>
                  ) : (
                    row
                  );
                })}
                {limitSessions &&
                  !searchActive &&
                  !showAllSessions &&
                  visibleSessions.length > SIDEBAR_SESSION_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      className={sidebarStyles.showAllSessions}
                      onClick={() => setShowAllSessions(true)}
                    >
                      {t('sidebar.showAllSessions')}
                    </button>
                  )}
              </>
            )}
          </div>
        )}
    </div>
  );
}

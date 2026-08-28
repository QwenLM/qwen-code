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
import { FolderClosedIcon, FolderOpenIcon } from 'lucide-react';
import { GitBranchIndicator } from '../GitBranchIndicator';
import { BranchPickerPopover } from '../BranchPickerPopover';
import { useI18n } from '../../i18n';
import { formatRelativeTime } from '../../utils/formatRelativeTime';
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
import { sessionMatchesGitQuery } from './sessionSearch';
import { measureSessionTitleScroll } from './sessionTitleScroll';
import { groupSessionsByChannelType } from './channelSessionGroups';
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
      size={16}
      strokeWidth={1.2}
      aria-hidden="true"
    />
  );
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
   * instead of a bespoke, feature-poor row.
   */
  renderSession: (session: DaemonSessionSummary) => ReactNode;
  mapSession?: (session: DaemonSessionSummary) => DaemonSessionSummary;
  showSessionDetails?: boolean;
  headerActions?: (visible: boolean) => ReactNode;
  onRenameGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  onDeleteGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  renameGroupLabel?: string;
  deleteGroupLabel?: string;
  groupActionsDisabled?: boolean;
  excludePinned?: boolean;
  limitSessions?: boolean;
  /**
   * Open the working-tree Changes dialog for this workspace. When provided, the
   * folder header shows a live git chip (branch + dirty/ahead-behind state) that
   * fires this on click. Omitted for untrusted workspaces (no git surface).
   */
  onOpenGitDiff?: (workspaceCwd: string) => void;
  onOpenCommit?: (workspaceCwd: string) => void;
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
  onRenameGroup,
  onDeleteGroup,
  renameGroupLabel,
  deleteGroupLabel,
  groupActionsDisabled,
  excludePinned = false,
  limitSessions = true,
  onOpenGitDiff,
  onOpenCommit,
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
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [gitStatus, setGitStatus] = useState<DaemonWorkspaceGitStatus>();
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
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
  const gitStatusEnabled = Boolean(onOpenGitDiff);

  // Log a poll failure only on the success→failure transition, not on every
  // 60s/focus tick, so an unreachable workspace doesn't spam a long-lived tab.
  const gitPollFailed = useRef(false);
  const loadGitStatus = useCallback(async () => {
    if (!gitStatusEnabled || !workspace.trusted || !gitPollCwd) return;
    try {
      // wait: the sidebar chip shows the enriched counters and has no SSE
      // fill-in path, so it keeps the blocking semantics instead of the
      // composer's last-known fast path.
      const status = await client
        .workspaceByCwd(gitPollCwd)
        .workspaceGit({ wait: true });
      gitPollFailed.current = false;
      setGitStatus(status);
    } catch (err) {
      // Keep the last known status on a transient failure so a brief network
      // or daemon blip doesn't blank the chip for a whole poll interval; log
      // only on the success→failure transition.
      if (!gitPollFailed.current) {
        console.warn('[WorkspaceSection] git status poll failed:', err);
        gitPollFailed.current = true;
      }
    }
  }, [client, gitPollCwd, gitStatusEnabled, workspace.trusted]);

  // The git chip lives in the always-visible folder header, so it polls
  // independently of session expansion: on mount/trust, on window focus, and on
  // a visibility-gated 60s tick (the daemon recomputes the working-tree summary
  // per call, so the cadence stays gentle). Skipped entirely when no diff
  // handler is wired, since the chip — its only consumer — would not render.
  useEffect(() => {
    if (!gitStatusEnabled || !workspace.trusted || !gitPollCwd) {
      setGitStatus(undefined);
      return;
    }
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

  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sessions
      .map((session) => mapSession?.(session) ?? session)
      .filter((session) => {
        if (excludePinned && session.isPinned) return false;
        if (!query) return true;
        const label = (session.displayName || '').toLowerCase();
        return (
          label.includes(query) ||
          session.sessionId.toLowerCase().includes(query) ||
          sessionMatchesGitQuery(session, query)
        );
      });
  }, [excludePinned, mapSession, searchQuery, sessions]);
  const directSessions =
    searchActive || showAllSessions || !limitSessions
      ? visibleSessions
      : visibleSessions.slice(0, SIDEBAR_SESSION_PREVIEW_LIMIT);

  const groupedSessions = useMemo(() => {
    if (!organizationEnabled || channelGroupingEnabled || groups.length === 0)
      return null;
    const assigned = new Set<string>();
    const sections = groups.map((group) => {
      const items = visibleSessions.filter(
        (session) => session.groupId === group.id,
      );
      items.forEach((session) => assigned.add(session.sessionId));
      return { group, sessions: items };
    });
    return {
      sections,
      ungrouped: visibleSessions.filter(
        (session) => !assigned.has(session.sessionId),
      ),
    };
  }, [channelGroupingEnabled, groups, organizationEnabled, visibleSessions]);

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

  return (
    <div className={styles.section}>
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
                <span className={styles.name}>{workspaceLabel(workspace)}</span>
              </span>
              {!workspace.trusted && (
                <span className={styles.badge}>{untrustedLabel}</span>
              )}
              {readOnly && (
                <span className={styles.badge}>{readOnlyLabel}</span>
              )}
            </>
          )}
        </button>
        {onOpenGitDiff && workspace.trusted && gitStatus?.branch && (
          <BranchPickerPopover
            open={branchPickerOpen}
            onOpenChange={setBranchPickerOpen}
            workspaceCwd={workspace.cwd}
            onBranchChanged={() => void loadGitStatus()}
            status={gitStatus}
            onStatusRefreshed={setGitStatus}
            onOpenDiff={() => onOpenGitDiff(workspace.cwd)}
            onOpenCommit={
              onOpenCommit ? () => onOpenCommit(workspace.cwd) : undefined
            }
          >
            <button
              type="button"
              className={styles.gitPill}
              aria-label={`${t('branchPicker.label')} — ${gitStatus.branch}`}
            >
              <GitBranchIndicator
                branch={gitStatus.branch}
                status={gitStatus}
                compact
              />
            </button>
          </BranchPickerPopover>
        )}
        {headerActions?.(actionsVisible)}
      </div>
      {renderSessions &&
        (expanded || Boolean(searchQuery.trim())) &&
        !disabled && (
          <div className={styles.sessions}>
            {loadError ? (
              <div className={styles.error} role="status">
                {loadErrorLabel}
              </div>
            ) : visibleSessions.length === 0 ? (
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
                    {group.sessions.map((session) => renderSession(session))}
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
                    {sessions.map((session) => renderSession(session))}
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
                      renderSession(session),
                    )}
                  </SessionGroupSection>
                )}
              </>
            ) : (
              <>
                {directSessions.map((session) => {
                  if (!readOnly) return renderSession(session);
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
                      time={stamp ? formatRelativeTime(stamp, t) : ''}
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import type {
  DaemonSessionGroup,
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';
import { FolderClosedIcon, FolderOpenIcon } from 'lucide-react';
import { GitBranchIndicator } from '../GitBranchIndicator';
import { SESSION_LIST_PAGE_SIZE } from '../../constants/sessions';
import {
  readWorkspaceCollapsedGroupIds,
  writeWorkspaceCollapsedGroupIds,
} from './collapsedSessionSections';
import { SessionGroupSection } from './SessionGroupSection';
import styles from './WorkspaceSection.module.css';

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function getWorkspaceName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
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
  primaryLabel: string;
  untrustedLabel: string;
  readOnlyLabel: string;
  trustToOpenLabel: string;
  noSessionsLabel: string;
  loadErrorLabel: string;
  organizationEnabled: boolean;
  ungroupedLabel: string;
  formatTime: (iso: string) => string;
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
  headerActions?: (visible: boolean) => ReactNode;
  onRenameGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  onDeleteGroup?: (group: DaemonSessionGroup, workspaceCwd: string) => void;
  renameGroupLabel?: string;
  deleteGroupLabel?: string;
  groupActionsDisabled?: boolean;
  excludePinned?: boolean;
  /**
   * Open the working-tree Changes dialog for this workspace. When provided, the
   * folder header shows a live git chip (branch + dirty/ahead-behind state) that
   * fires this on click. Omitted for untrusted workspaces (no git surface).
   */
  onOpenGitDiff?: (workspaceCwd: string) => void;
}

export function WorkspaceSection({
  workspace,
  renderHeader,
  client,
  reloadToken,
  primaryLabel,
  untrustedLabel,
  readOnlyLabel,
  trustToOpenLabel,
  noSessionsLabel,
  loadErrorLabel,
  organizationEnabled,
  ungroupedLabel,
  formatTime,
  searchQuery = '',
  expanded: controlledExpanded,
  autoExpandKey,
  onExpandedChange,
  renderSessions = true,
  renderSession,
  headerActions,
  onRenameGroup,
  onDeleteGroup,
  renameGroupLabel,
  deleteGroupLabel,
  groupActionsDisabled,
  excludePinned = false,
  onOpenGitDiff,
}: WorkspaceSectionProps) {
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [groups, setGroups] = useState<DaemonSessionGroup[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() =>
    readWorkspaceCollapsedGroupIds(workspace.id),
  );
  const [actionsVisible, setActionsVisible] = useState(false);
  const [gitStatus, setGitStatus] = useState<DaemonWorkspaceGitStatus>();
  const expanded = controlledExpanded ?? internalExpanded;
  const readOnly = !workspace.primary && !workspace.trusted;
  const disabled = workspace.primary && !workspace.trusted;

  // A workspace always starts collapsed, including the primary workspace.
  useEffect(() => {
    if (controlledExpanded === undefined) setInternalExpanded(false);
  }, [controlledExpanded, workspace.id]);

  // The render site keys this component by workspace id, so an id change
  // always remounts and the lazy useState initializer re-reads storage.
  useEffect(() => {
    writeWorkspaceCollapsedGroupIds(workspace.id, collapsedGroupIds);
  }, [collapsedGroupIds, workspace.id]);

  useEffect(() => {
    if (controlledExpanded === undefined && autoExpandKey) {
      setInternalExpanded(true);
    }
  }, [autoExpandKey, controlledExpanded]);

  const loadSessions = useCallback(async () => {
    if (disabled) return;
    try {
      const result = await client
        .workspaceByCwd(workspace.cwd)
        .listWorkspaceSessions({
          pageSize: SESSION_LIST_PAGE_SIZE,
          archiveState: 'active',
          ...(organizationEnabled
            ? { view: 'organized' as const, group: 'all' }
            : {}),
        });
      setSessions(result);
      setLoadError(false);
    } catch (err) {
      // Surface connectivity failures so users can distinguish a broken
      // daemon from genuinely zero sessions.
      console.warn('[WorkspaceSection] session poll failed:', err);
      setLoadError(true);
    }
  }, [client, disabled, organizationEnabled, workspace.cwd]);

  useEffect(() => {
    if (!renderSessions || disabled || !organizationEnabled) {
      setGroups([]);
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
    client,
    disabled,
    organizationEnabled,
    reloadToken,
    renderSessions,
    workspace.cwd,
  ]);

  useEffect(() => {
    if (!renderSessions) return;
    if (!expanded && !searchQuery.trim()) return;
    void loadSessions();
    if (readOnly) return;
    const timer = setInterval(() => void loadSessions(), 10_000);
    return () => clearInterval(timer);
  }, [
    expanded,
    loadSessions,
    readOnly,
    reloadToken,
    renderSessions,
    searchQuery,
  ]);

  // Log a poll failure only on the success→failure transition, not on every
  // 60s/focus tick, so an unreachable workspace doesn't spam a long-lived tab.
  const gitPollFailed = useRef(false);
  const loadGitStatus = useCallback(async () => {
    if (!onOpenGitDiff || !workspace.trusted) return;
    try {
      const status = await client.workspaceByCwd(workspace.cwd).workspaceGit();
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
  }, [client, onOpenGitDiff, workspace.cwd, workspace.trusted]);

  // The git chip lives in the always-visible folder header, so it polls
  // independently of session expansion: on mount/trust, on window focus, and on
  // a visibility-gated 60s tick (the daemon recomputes the working-tree summary
  // per call, so the cadence stays gentle). Skipped entirely when no diff
  // handler is wired, since the chip — its only consumer — would not render.
  useEffect(() => {
    if (!onOpenGitDiff || !workspace.trusted) {
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
  }, [loadGitStatus, onOpenGitDiff, reloadToken, workspace.trusted]);

  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return sessions.filter((session) => {
      if (excludePinned && session.isPinned) return false;
      if (!query) return true;
      const label = (session.displayName || '').toLowerCase();
      return (
        label.includes(query) || session.sessionId.toLowerCase().includes(query)
      );
    });
  }, [excludePinned, searchQuery, sessions]);

  const groupedSessions = useMemo(() => {
    if (!organizationEnabled || groups.length === 0) return null;
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
  }, [groups, organizationEnabled, visibleSessions]);

  return (
    <div className={styles.section}>
      <div
        className={cx(styles.headerRow, disabled && styles.headerDisabled)}
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
          onClick={() => {
            const nextExpanded = !expanded;
            setInternalExpanded(nextExpanded);
            onExpandedChange?.(nextExpanded);
          }}
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
                <span className={styles.name}>
                  {getWorkspaceName(workspace.cwd)}
                </span>
                {workspace.primary && primaryLabel && (
                  <span className={styles.badge}>{primaryLabel}</span>
                )}
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
          <span className={styles.gitPill}>
            <GitBranchIndicator
              branch={gitStatus.branch}
              status={gitStatus}
              compact
              onOpenDiff={() => onOpenGitDiff(workspace.cwd)}
            />
          </span>
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
              <div className={styles.empty}>{noSessionsLabel}</div>
            ) : groupedSessions ? (
              <>
                {groupedSessions.sections.map(({ group, sessions }) => (
                  <SessionGroupSection
                    id={`group:${group.id}`}
                    key={group.id}
                    label={group.name}
                    count={sessions.length}
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
                    id="ungrouped"
                    label={ungroupedLabel}
                    count={groupedSessions.ungrouped.length}
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
              visibleSessions.map((session) => {
                if (!readOnly) return renderSession(session);
                const label = getSessionLabel(session);
                const time = session.createdAt
                  ? formatTime(session.createdAt)
                  : '';
                return (
                  <div
                    key={session.sessionId}
                    className={styles.sessionItemReadOnly}
                    role="note"
                    aria-label={`${label}${time ? `, ${time}` : ''}. ${trustToOpenLabel}`}
                  >
                    <span className={styles.sessionName}>{label}</span>
                    {time && <span className={styles.sessionTime}>{time}</span>}
                  </div>
                );
              })
            )}
          </div>
        )}
    </div>
  );
}

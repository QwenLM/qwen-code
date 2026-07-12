import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { FolderClosedIcon, FolderOpenIcon } from 'lucide-react';
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
  client: DaemonClient;
  isActive: boolean;
  reloadToken: number;
  primaryLabel: string;
  untrustedLabel: string;
  readOnlyLabel: string;
  trustToOpenLabel: string;
  noSessionsLabel: string;
  loadErrorLabel: string;
  formatTime: (iso: string) => string;
  searchQuery?: string;
  expanded?: boolean;
  autoExpandKey?: string;
  onExpandedChange?: (expanded: boolean) => void;
  content?: ReactNode;
  /**
   * Render one session row. The sidebar passes its shared `renderSessionRow`
   * so per-workspace sessions match the single-workspace list exactly — same
   * type scale, hover actions (pin, archive, export, more…), and states —
   * instead of a bespoke, feature-poor row.
   */
  renderSession: (session: DaemonSessionSummary) => ReactNode;
  headerActions?: (visible: boolean) => ReactNode;
}

export function WorkspaceSection({
  workspace,
  client,
  isActive,
  reloadToken,
  primaryLabel,
  untrustedLabel,
  readOnlyLabel,
  trustToOpenLabel,
  noSessionsLabel,
  loadErrorLabel,
  formatTime,
  searchQuery = '',
  expanded: controlledExpanded,
  autoExpandKey,
  onExpandedChange,
  content,
  renderSession,
  headerActions,
}: WorkspaceSectionProps) {
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [internalExpanded, setInternalExpanded] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const expanded = controlledExpanded ?? internalExpanded;
  const readOnly = !workspace.primary && !workspace.trusted;
  const disabled = workspace.primary && !workspace.trusted;

  // A workspace always starts collapsed, including the primary workspace.
  useEffect(() => {
    if (controlledExpanded === undefined) setInternalExpanded(false);
  }, [controlledExpanded, workspace.id]);

  useEffect(() => {
    if (controlledExpanded === undefined && autoExpandKey) {
      setInternalExpanded(true);
    }
  }, [autoExpandKey, controlledExpanded]);

  const loadSessions = useCallback(async () => {
    if (disabled) return;
    try {
      const result = await client.listWorkspaceSessions(workspace.cwd, {
        archiveState: 'active',
      });
      setSessions(result);
      setLoadError(false);
    } catch (err) {
      // Surface connectivity failures so users can distinguish a broken
      // daemon from genuinely zero sessions.
      console.warn('[WorkspaceSection] session poll failed:', err);
      setLoadError(true);
    }
  }, [client, disabled, workspace.cwd]);

  useEffect(() => {
    if (content !== undefined) return;
    if (!expanded && !searchQuery.trim()) return;
    void loadSessions();
    if (readOnly) return;
    const timer = setInterval(() => void loadSessions(), 10_000);
    return () => clearInterval(timer);
  }, [content, expanded, loadSessions, readOnly, reloadToken, searchQuery]);

  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => {
      const label = (session.displayName || '').toLowerCase();
      return (
        label.includes(query) || session.sessionId.toLowerCase().includes(query)
      );
    });
  }, [searchQuery, sessions]);

  return (
    <div className={styles.section}>
      <div
        className={cx(
          styles.headerRow,
          isActive && styles.headerActive,
          disabled && styles.headerDisabled,
        )}
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
          <span className={cx(styles.chevron, expanded && styles.chevronOpen)}>
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
          {readOnly && <span className={styles.badge}>{readOnlyLabel}</span>}
        </button>
        {!readOnly && !disabled && headerActions?.(actionsVisible)}
      </div>
      {(expanded || Boolean(searchQuery.trim())) && !disabled && (
        <div className={styles.sessions}>
          {content !== undefined ? (
            content
          ) : loadError ? (
            <div className={styles.error} role="status">
              {loadErrorLabel}
            </div>
          ) : visibleSessions.length === 0 ? (
            <div className={styles.empty}>{noSessionsLabel}</div>
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

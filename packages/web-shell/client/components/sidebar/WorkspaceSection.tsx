import { useEffect, useState, useCallback, type ReactNode } from 'react';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import type {
  DaemonSessionSummary,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import styles from './WorkspaceSection.module.css';

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function getWorkspaceName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={styles.folderIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
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
  onSelectWorkspace: (cwd: string | undefined) => void;
  /**
   * Render one session row. The sidebar passes its shared `renderSessionRow`
   * so per-workspace sessions match the single-workspace list exactly — same
   * type scale, hover actions (pin, archive, export, more…), and states —
   * instead of a bespoke, feature-poor row.
   */
  renderSession: (session: DaemonSessionSummary) => ReactNode;
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
  onSelectWorkspace,
  renderSession,
}: WorkspaceSectionProps) {
  const [sessions, setSessions] = useState<DaemonSessionSummary[]>([]);
  const [expanded, setExpanded] = useState(workspace.primary);
  const readOnly = !workspace.primary && !workspace.trusted;
  const disabled = workspace.primary && !workspace.trusted;

  // Sync if the primary flag changes after mount (e.g. capabilities refresh).
  useEffect(() => {
    setExpanded(workspace.primary);
  }, [workspace.primary]);

  const loadSessions = useCallback(async () => {
    if (disabled) return;
    try {
      const result = await client.listWorkspaceSessions(workspace.cwd, {
        archiveState: 'active',
      });
      setSessions(result);
    } catch (err) {
      // Surface connectivity failures so users can distinguish a broken
      // daemon from genuinely zero sessions.
      console.warn('[WorkspaceSection] session poll failed:', err);
      setSessions([]);
    }
  }, [client, disabled, workspace.cwd]);

  useEffect(() => {
    if (!expanded) return;
    void loadSessions();
    if (readOnly) return;
    const timer = setInterval(() => void loadSessions(), 10_000);
    return () => clearInterval(timer);
  }, [expanded, loadSessions, readOnly, reloadToken]);

  return (
    <div className={styles.section}>
      <button
        className={cx(
          styles.header,
          isActive && styles.headerActive,
          disabled && styles.headerDisabled,
        )}
        disabled={disabled}
        aria-expanded={expanded}
        onClick={() => {
          if (!readOnly) {
            onSelectWorkspace(workspace.primary ? undefined : workspace.cwd);
          }
          setExpanded((v) => !v);
        }}
      >
        <span className={cx(styles.chevron, expanded && styles.chevronOpen)}>
          <FolderIcon open={expanded} />
        </span>
        <span className={styles.name}>{getWorkspaceName(workspace.cwd)}</span>
        {workspace.primary && (
          <span className={styles.badge}>{primaryLabel}</span>
        )}
        {!workspace.trusted && (
          <span className={styles.badge}>{untrustedLabel}</span>
        )}
        {readOnly && <span className={styles.badge}>{readOnlyLabel}</span>}
      </button>
      {expanded && !disabled && (
        <div className={styles.sessions}>
          {sessions.length === 0 ? (
            <div className={styles.empty}>{noSessionsLabel}</div>
          ) : (
            sessions.map((session) => renderSession(session))
          )}
        </div>
      )}
    </div>
  );
}

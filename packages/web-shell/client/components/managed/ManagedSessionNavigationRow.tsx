import type { CSSProperties, ReactNode } from 'react';
import { GitForkIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { formatDateTime } from '../../utils/formatDateTime';
import { SessionDetailsTooltip } from '../sidebar/SessionDetailsTooltip';
import { measureSessionTitleScroll } from '../sidebar/sessionTitleScroll';
import styles from '../sidebar/WebShellSidebar.module.css';
import { ManagedWorktreeStatus } from './ManagedSessionWorktrees';
import {
  isManagedSessionRunning,
  type ManagedAgentSessionSummary,
} from './managed-agent-provider';

export function ManagedSessionNavigationRow({
  session,
  active,
  workspaceLabel,
  onSelect,
  actions,
}: {
  session: ManagedAgentSessionSummary;
  active: boolean;
  workspaceLabel?: string;
  onSelect: () => void;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const running = isManagedSessionRunning(session.phase);
  const label = session.title || session.sessionId;
  const folder = session.workspace
    ? `${workspaceLabel || session.workspace.workspaceId}${session.workspace.cwdRelative === '.' ? '' : ` / ${session.workspace.cwdRelative}`}`
    : t('sidebar.noWorkspace');
  return (
    <SessionDetailsTooltip
      session={{ sessionId: session.sessionId, workspaceCwd: folder }}
      label={label}
      time={formatDateTime(
        new Date(session.updatedAt || session.createdAt).toISOString(),
      )}
      completedUnread={false}
      statusLabel={t(
        session.lifecycleStatus && session.lifecycleStatus !== 'active'
          ? `managed.sessionState.${session.lifecycleStatus}`
          : `managed.phase.${session.phase}`,
      )}
      details={
        session.worktree && (
          <ManagedWorktreeStatus worktree={session.worktree} />
        )
      }
    >
      <div
        className={`${styles.sessionRow} ${active ? styles.currentSession : ''} ${running ? styles.runningSession : ''}`}
        data-managed-session-id={session.sessionId}
        role="button"
        tabIndex={0}
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
        onMouseEnter={(event) => measureSessionTitleScroll(event.currentTarget)}
        onFocus={(event) => measureSessionTitleScroll(event.currentTarget)}
      >
        <span className={styles.sessionStatusSlot} aria-hidden="true">
          {running && (
            <span
              className={`${styles.sessionStatusDot} ${styles.sessionStatusDotRunning}`}
              data-web-shell-session-running
            />
          )}
        </span>
        <span className={styles.sessionText} data-web-shell-session-title>
          <span className={styles.sessionTextInner}>{label}</span>
        </span>
        <div
          className={styles.sessionMetaSlot}
          style={
            {
              '--session-actions-width': actions ? '26px' : '0px',
            } as CSSProperties
          }
        >
          {running ? (
            <span
              className={styles.sessionLoading}
              role="status"
              aria-label={t('sidebar.running')}
            />
          ) : session.worktree ? (
            <span className={styles.sessionGitIcon}>
              <GitForkIcon aria-label={t('sidebar.newWorktreeTask')} />
            </span>
          ) : null}
          {actions && (
            <div
              className={styles.sessionActions}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              {actions}
            </div>
          )}
        </div>
      </div>
    </SessionDetailsTooltip>
  );
}

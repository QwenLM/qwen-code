import type { ReactNode } from 'react';
import styles from './WebShellSidebar.module.css';

export function SidebarSectionHeader({
  label,
  expanded,
  onToggle,
  action,
}: {
  label: string;
  expanded?: boolean;
  onToggle?: () => void;
  action?: ReactNode;
}) {
  return (
    <div className={`relative ${styles.projectsHeader}`}>
      {onToggle ? (
        <button
          className={styles.projectsHeaderToggle}
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span>{label}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {expanded ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
          </svg>
        </button>
      ) : (
        <h3
          className={styles.projectsHeaderToggle}
          style={{ margin: 0, cursor: 'default' }}
        >
          {label}
        </h3>
      )}
      {action && <div className={styles.workspaceHeaderActions}>{action}</div>}
    </div>
  );
}

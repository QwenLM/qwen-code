import type { CSSProperties, ReactNode } from 'react';
import type { DaemonSessionGroupColor } from '@qwen-code/sdk/daemon';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import styles from './WebShellSidebar.module.css';

export interface SessionGroupSectionProps {
  id: string;
  label: string;
  count: number;
  expanded: boolean;
  color?: DaemonSessionGroupColor;
  children: ReactNode;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  renameLabel?: string;
  deleteLabel?: string;
  actionsDisabled?: boolean;
}

export function SessionGroupSection({
  label,
  count,
  expanded,
  color,
  children,
  onToggle,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  actionsDisabled,
}: SessionGroupSectionProps) {
  const colorClass = color?.startsWith('#')
    ? styles.groupColorCustom
    : color
      ? styles[
          `groupColor${color[0]!.toUpperCase()}${color.slice(1)}` as keyof typeof styles
        ]
      : styles.sessionGroupDotMuted;
  const dotStyle: CSSProperties | undefined = color?.startsWith('#')
    ? ({ '--session-group-custom-color': color } as CSSProperties)
    : undefined;
  return (
    <section className={styles.sessionGroupSection} aria-label={label}>
      <div className={styles.sessionGroupHeaderRow}>
        <button
          type="button"
          className={styles.sessionGroupHeader}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span
            className={`${styles.sessionGroupDot} ${colorClass}`}
            style={dotStyle}
            aria-hidden="true"
          />
          <span className={styles.sessionGroupTitle}>{label}</span>
          <span className={styles.sessionGroupCount}>· {count}</span>
          <span className={styles.sessionGroupChevron} aria-hidden="true">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
        </button>
        {(onRename || onDelete) && (
          <div className={styles.sessionGroupHeaderActions}>
            {onRename && (
              <button
                className={styles.sessionGroupActionButton}
                type="button"
                title={renameLabel}
                aria-label={renameLabel}
                disabled={actionsDisabled}
                onClick={onRename}
              >
                <PencilIcon />
              </button>
            )}
            {onDelete && (
              <button
                className={styles.sessionGroupActionButton}
                type="button"
                title={deleteLabel}
                aria-label={deleteLabel}
                disabled={actionsDisabled}
                onClick={onDelete}
              >
                <Trash2Icon />
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && <div className={styles.sessionGroupList}>{children}</div>}
    </section>
  );
}

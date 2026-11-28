import {
  Children,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { DaemonSessionGroupColor } from '@qwen-code/sdk/daemon';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisVerticalIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  SIDEBAR_SESSION_EXPAND_STEP,
  SIDEBAR_SESSION_PREVIEW_LIMIT,
} from '../../constants/sessions';
import { useI18n } from '../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import styles from './WebShellSidebar.module.css';

const GROUP_MENU_PORTAL_STYLE: CSSProperties = {
  zIndex: 'calc(var(--web-shell-popover-z-index, 1000) + 1)',
};

export interface SessionGroupSectionProps {
  id: string;
  label: string;
  count: number;
  expanded: boolean;
  color?: DaemonSessionGroupColor;
  icon?: ReactNode;
  children?: ReactNode;
  itemCount?: number;
  renderChildren?: (visibleCount: number) => ReactNode;
  onToggle: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  renameLabel?: string;
  deleteLabel?: string;
  actionsDisabled?: boolean;
  limitSessions?: boolean;
  isTouchActions?: boolean;
}

export function SessionGroupSection({
  label,
  count,
  expanded,
  color,
  icon,
  children,
  itemCount,
  renderChildren,
  onToggle,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  actionsDisabled,
  limitSessions = true,
  isTouchActions = false,
}: SessionGroupSectionProps) {
  const { t } = useI18n();
  const [visibleCount, setVisibleCount] = useState(
    SIDEBAR_SESSION_PREVIEW_LIMIT,
  );
  const items = Children.toArray(children);
  const total = itemCount ?? items.length;
  useEffect(() => {
    if (!expanded) setVisibleCount(SIDEBAR_SESSION_PREVIEW_LIMIT);
  }, [expanded]);
  const previewLimited = limitSessions && total > visibleCount;
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
  const renameText = renameLabel ?? t('sidebar.groupRename');
  const deleteText = deleteLabel ?? t('sidebar.groupDelete');
  return (
    <section className={styles.sessionGroupSection} aria-label={label}>
      <div className={styles.sessionGroupHeaderRow}>
        <button
          type="button"
          className={styles.sessionGroupHeader}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {icon ? (
            <span className={styles.sessionGroupIcon} aria-hidden="true">
              {icon}
            </span>
          ) : (
            <span
              className={`${styles.sessionGroupDot} ${colorClass}`}
              style={dotStyle}
              aria-hidden="true"
            />
          )}
          <span className={styles.sessionGroupTitle}>{label}</span>
          <span className={styles.sessionGroupCount}>· {count}</span>
          <span className={styles.sessionGroupChevron} aria-hidden="true">
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </span>
        </button>
        {(onRename || onDelete) && (
          <div
            className={styles.sessionGroupHeaderActions}
            data-touch-actions={isTouchActions ? 'true' : undefined}
          >
            {isTouchActions ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className={styles.sessionGroupActionButton}
                    type="button"
                    title={t('sidebar.moreActions')}
                    aria-label={`${t('sidebar.moreActions')}: ${label}`}
                    disabled={actionsDisabled}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <EllipsisVerticalIcon />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-auto min-w-36"
                  style={GROUP_MENU_PORTAL_STYLE}
                >
                  {onRename && (
                    <DropdownMenuItem
                      className="min-h-11 gap-2 px-3 py-2"
                      disabled={actionsDisabled}
                      onSelect={onRename}
                    >
                      <PencilIcon />
                      {renameText}
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <DropdownMenuItem
                      variant="destructive"
                      className="min-h-11 gap-2 px-3 py-2"
                      disabled={actionsDisabled}
                      onSelect={onDelete}
                    >
                      <Trash2Icon />
                      {deleteText}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
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
              </>
            )}
          </div>
        )}
      </div>
      {expanded && (
        <div className={styles.sessionGroupList}>
          {renderChildren
            ? renderChildren(previewLimited ? visibleCount : total)
            : previewLimited
              ? items.slice(0, visibleCount)
              : items}
          {previewLimited && (
            <button
              type="button"
              className={styles.showAllSessions}
              onClick={() =>
                setVisibleCount((count) => count + SIDEBAR_SESSION_EXPAND_STEP)
              }
            >
              {t('sidebar.showMoreSessions', {
                count: Math.min(
                  SIDEBAR_SESSION_EXPAND_STEP,
                  total - visibleCount,
                ),
              })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

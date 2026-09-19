import { memo } from 'react';
import type { TodoItem } from '../../adapters/types';
import {
  getOrderedStickyTodos,
  getTodoStatusIcon,
  STICKY_TODO_MAX_VISIBLE_ITEMS,
} from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './StickyPlanStrip.module.css';

interface StickyPlanStripProps {
  /** Latest plan for the active session, in transcript order. */
  todos: TodoItem[];
  /** Fold the list into the one-line summary. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Opens the existing plan surface (workflow cockpit or tasks panel). */
  onOpen?: () => void;
  hasLiveActivity?: boolean;
}

function getStatusClass(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return styles.completed;
    case 'in_progress':
      return styles.inProgress;
    case 'pending':
      return styles.pending;
  }
}

/**
 * Pinned plan strip above the transcript. Mirrors the terminal's sticky todo
 * panel: same ordering and five-item cap (`getOrderedStickyTodos`), so the two
 * surfaces do not drift.
 */
export const StickyPlanStrip = memo(function StickyPlanStrip({
  todos,
  collapsed,
  onToggleCollapsed,
  onOpen,
  hasLiveActivity = true,
}: StickyPlanStripProps) {
  const { t } = useI18n();
  // Same split as the terminal: order, then drop completed items for the visible
  // rows — but keep the unsorted list for the step counter, whose number must
  // match the item's position in the plan rather than in the sorted order.
  const ordered = getOrderedStickyTodos(todos).filter(
    (todo) => todo.status !== 'completed',
  );
  if (ordered.length === 0) return null;

  const inProgressIdx = todos.findIndex(
    (todo) => todo.status === 'in_progress',
  );
  const pendingIdx = todos.findIndex((todo) => todo.status === 'pending');
  const currentIdx = inProgressIdx >= 0 ? inProgressIdx : pendingIdx;
  const current = currentIdx >= 0 ? currentIdx + 1 : todos.length;

  const visible = ordered.slice(0, STICKY_TODO_MAX_VISIBLE_ITEMS);
  const hiddenCount = ordered.length - visible.length;
  const progressLabel = t('todo.stepProgress', {
    current,
    total: todos.length,
  });

  return (
    <section className={styles.strip} aria-label={t('todo.title')}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('todo.expand') : t('todo.collapse')}
          onClick={onToggleCollapsed}
        >
          <svg
            className={`${styles.chevron} ${collapsed ? styles.chevronCollapsed : ''}`}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        </button>
        {onOpen ? (
          <button type="button" className={styles.progress} onClick={onOpen}>
            {progressLabel}
          </button>
        ) : (
          <span className={styles.progress}>{progressLabel}</span>
        )}
      </div>

      {!collapsed && (
        <ul className={styles.items}>
          {visible.map((todo, index) => (
            <li
              key={`${todo.id || index}:${todo.content}`}
              className={`${styles.item} ${getStatusClass(todo.status)}`}
            >
              <span className={styles.icon} aria-hidden="true">
                {todo.status === 'in_progress' && hasLiveActivity ? (
                  <span className={styles.loadingIcon} />
                ) : (
                  getTodoStatusIcon(todo.status)
                )}
              </span>
              <span className={styles.content} title={todo.content}>
                {todo.content}
              </span>
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className={styles.more}>
              {t('todo.more', { count: hiddenCount })}
            </li>
          )}
        </ul>
      )}
    </section>
  );
});

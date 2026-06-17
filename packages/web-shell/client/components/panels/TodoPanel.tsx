import { memo, useState } from 'react';
import type { TodoItem } from '../../adapters/types';
import { getTodoStatusIcon, getTodoWindow } from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './TodoPanel.module.css';

interface TodoPanelProps {
  todos: TodoItem[];
  title?: string;
  /** Scroll the transcript to the message the todos came from. */
  onLocateSource?: () => void;
}

const MAX_VISIBLE = 5;
const COLLAPSED_STORAGE_KEY = 'web-shell:todo-panel-collapsed';

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean) {
  try {
    window.localStorage.setItem(
      COLLAPSED_STORAGE_KEY,
      collapsed ? 'true' : 'false',
    );
  } catch {
    // Ignore storage failures in private browsing or restricted contexts.
  }
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

export const TodoPanel = memo(function TodoPanel({
  todos,
  title,
  onLocateSource,
}: TodoPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [showAll, setShowAll] = useState(false);
  if (todos.length === 0) return null;

  const total = todos.length;
  const completedCount = todos.filter(
    (todo) => todo.status === 'completed',
  ).length;
  const allCompleted = completedCount === total;

  // Current item: first in_progress, else first pending.
  const inProgressIdx = todos.findIndex((td) => td.status === 'in_progress');
  const currentIdx =
    inProgressIdx >= 0
      ? inProgressIdx
      : todos.findIndex((td) => td.status === 'pending');
  const current = currentIdx >= 0 ? todos[currentIdx] : undefined;

  const { start, end } = showAll
    ? { start: 0, end: total }
    : getTodoWindow(todos, MAX_VISIBLE);
  const visible = todos.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;
  const hiddenAboveAllCompleted = todos
    .slice(0, start)
    .every((td) => td.status === 'completed');

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(next);
      return next;
    });
  };

  // Number column sized to the widest index ("10." is wider than "9.") so
  // the status icons stay aligned past 9 items; exact in the mono font.
  const numColumnWidth = `${String(total).length + 1}ch`;

  return (
    <section className={styles.panel} aria-label={title ?? t('todo.title')}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? t('todo.expand') : t('todo.collapse')}
        >
          <span className={styles.chevron} aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className={styles.title}>{title ?? t('todo.title')}</span>
          <span className={styles.progress}>
            {completedCount}/{total}
          </span>
          {collapsed &&
            (allCompleted ? (
              <span className={`${styles.collapsedCurrent} ${styles.allDone}`}>
                ✓ {t('todo.allDone')}
              </span>
            ) : current ? (
              <span
                className={`${styles.collapsedCurrent} ${getStatusClass(current.status)}`}
              >
                <span className={styles.icon} aria-hidden="true">
                  {getTodoStatusIcon(current.status)}
                </span>
                <span className={styles.content} title={current.content}>
                  {current.content}
                </span>
              </span>
            ) : null)}
        </button>
        {onLocateSource && (
          <button
            type="button"
            className={styles.locate}
            onClick={onLocateSource}
            title={t('todo.locate')}
            aria-label={t('todo.locate')}
          >
            ↗
          </button>
        )}
      </div>
      {!collapsed && (
        <div className={styles.list}>
          {allCompleted ? (
            <div className={styles.allDone}>✓ {t('todo.allDone')}</div>
          ) : (
            <>
              {hiddenAbove > 0 && (
                <button
                  type="button"
                  className={styles.moreLine}
                  onClick={() => setShowAll(true)}
                >
                  <span
                    className={styles.num}
                    style={{ width: numColumnWidth }}
                  />
                  <span className={styles.moreText}>
                    {hiddenAboveAllCompleted
                      ? t('todo.completedAbove', { count: hiddenAbove })
                      : t('todo.moreAbove', { count: hiddenAbove })}
                  </span>
                </button>
              )}
              {visible.map((todo, i) => (
                <div
                  key={todo.id || start + i}
                  className={`${styles.item} ${getStatusClass(todo.status)}`}
                >
                  <span
                    className={styles.num}
                    style={{ width: numColumnWidth }}
                  >
                    {start + i + 1}.
                  </span>
                  <span className={styles.icon} aria-hidden="true">
                    {getTodoStatusIcon(todo.status)}
                  </span>
                  <span className={styles.content} title={todo.content}>
                    {todo.content}
                  </span>
                </div>
              ))}
              {hiddenBelow > 0 && (
                <button
                  type="button"
                  className={styles.moreLine}
                  onClick={() => setShowAll(true)}
                >
                  <span
                    className={styles.num}
                    style={{ width: numColumnWidth }}
                  />
                  <span className={styles.moreText}>
                    {t('todo.more', { count: hiddenBelow })}
                  </span>
                </button>
              )}
              {showAll && total > MAX_VISIBLE && (
                <button
                  type="button"
                  className={styles.moreLine}
                  onClick={() => setShowAll(false)}
                >
                  <span
                    className={styles.num}
                    style={{ width: numColumnWidth }}
                  />
                  <span className={styles.moreText}>{t('todo.showLess')}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
});

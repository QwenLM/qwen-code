import type { TodoItem } from '../../adapters/types';
import { getTodoStatusIcon, type TodoEvent } from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './TodoView.module.css';

function statusClass(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return styles.completed;
    case 'in_progress':
      return styles.inProgress;
    case 'pending':
      return '';
  }
}

/**
 * Collapsed view: the change a single snapshot introduced — items that just
 * completed and items that just started. With no tracked change (an unchanged
 * re-emit, or a snapshot rendered without a timeline) it falls back to the
 * current focus item so the row is never empty.
 */
export function TodoEventSummary({
  todos,
  events,
}: {
  todos: TodoItem[];
  events: readonly TodoEvent[];
}) {
  const { t } = useI18n();

  if (events.length === 0) {
    const allCompleted =
      todos.length > 0 && todos.every((td) => td.status === 'completed');
    if (allCompleted) {
      return (
        <div className={styles.summary}>
          <div className={`${styles.row} ${styles.completed}`}>
            <span className={styles.icon} aria-hidden="true">
              ✓
            </span>
            <span className={styles.text}>{t('todo.allDone')}</span>
          </div>
        </div>
      );
    }
    const current =
      todos.find((td) => td.status === 'in_progress') ??
      todos.find((td) => td.status === 'pending');
    if (!current) return null;
    return (
      <div className={styles.summary}>
        <div className={`${styles.row} ${statusClass(current.status)}`}>
          <span className={styles.icon} aria-hidden="true">
            {getTodoStatusIcon(current.status)}
          </span>
          <span className={styles.text}>{current.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.summary}>
      {events.map((event) => (
        <div
          key={`${event.kind}-${event.id}`}
          className={`${styles.row} ${
            event.kind === 'completed' ? styles.completed : styles.inProgress
          }`}
        >
          <span className={styles.icon} aria-hidden="true">
            {getTodoStatusIcon(
              event.kind === 'completed' ? 'completed' : 'in_progress',
            )}
          </span>
          <span className={styles.text}>{event.content}</span>
        </div>
      ))}
    </div>
  );
}

/** Expanded view: the full list. `numbered` adds the 1. 2. 3. index column. */
export function TodoFullList({
  todos,
  numbered = false,
}: {
  todos: TodoItem[];
  numbered?: boolean;
}) {
  // Size the number column to the widest index so the markers stay aligned once
  // the list grows past 9 items.
  const numColumnWidth = `${String(todos.length).length + 1}ch`;
  return (
    <div className={styles.list}>
      {todos.map((todo, index) => (
        <div
          key={todo.id || index}
          className={`${styles.row} ${statusClass(todo.status)}`}
        >
          {numbered && (
            <span className={styles.num} style={{ minWidth: numColumnWidth }}>
              {index + 1}.
            </span>
          )}
          <span className={styles.icon} aria-hidden="true">
            {getTodoStatusIcon(todo.status)}
          </span>
          <span className={styles.text}>{todo.content}</span>
        </div>
      ))}
    </div>
  );
}

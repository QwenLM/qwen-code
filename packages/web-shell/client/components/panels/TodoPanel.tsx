import type { TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import styles from './TodoPanel.module.css';

interface TodoPanelProps {
  todos: TodoItem[];
  title?: string;
}

const MAX_VISIBLE = 5;

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

export function TodoPanel({ todos, title }: TodoPanelProps) {
  const { t } = useI18n();
  if (todos.length === 0) return null;

  // Rotate list so the current in_progress item is first
  const currentIdx = todos.findIndex((t) => t.status === 'in_progress');
  const startIdx =
    currentIdx >= 0
      ? currentIdx
      : todos.findIndex((t) => t.status === 'pending');
  const rotated =
    startIdx > 0
      ? [...todos.slice(startIdx), ...todos.slice(0, startIdx)]
      : todos;

  const visible = rotated.slice(0, MAX_VISIBLE);
  const remaining = rotated.length - MAX_VISIBLE;

  // Map back to original index for numbering
  const originalIndices =
    startIdx > 0
      ? [...Array(todos.length).keys()].map(
          (i) => (i + startIdx) % todos.length,
        )
      : [...Array(todos.length).keys()];

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{title ?? t('todo.title')}</span>
      </div>
      <div className={styles.list}>
        {visible.map((todo, i) => (
          <div
            key={todo.id || i}
            className={`${styles.item} ${getStatusClass(todo.status)}`}
          >
            <span className={styles.num}>{originalIndices[i] + 1}.</span>
            <span className={styles.icon}>
              {todo.status === 'completed'
                ? '●'
                : todo.status === 'in_progress'
                  ? '◐'
                  : '○'}
            </span>
            <span className={styles.content}>{todo.content}</span>
          </div>
        ))}
        {remaining > 0 && (
          <div className={`${styles.item} ${styles.more}`}>
            <span className={styles.num}></span>
            <span className={styles.content}>
              {t('todo.more', { count: remaining })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

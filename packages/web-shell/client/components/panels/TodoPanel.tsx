import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { TodoItem } from '../../adapters/types';
import { getTodoStatusIcon } from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './TodoPanel.module.css';

interface TodoPanelProps {
  todos: TodoItem[];
  title?: string;
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
}: TodoPanelProps) {
  const { t } = useI18n();
  if (todos.length === 0) return null;

  const total = todos.length;
  const inProgressIdx = todos.findIndex((td) => td.status === 'in_progress');
  const currentIdx =
    inProgressIdx >= 0
      ? inProgressIdx
      : todos.findIndex((td) => td.status === 'pending');
  const stepIndex = currentIdx >= 0 ? currentIdx + 1 : total;
  const progress = total > 0 ? stepIndex / total : 0;

  return (
    <section
      className={styles.panel}
      aria-label={title ?? t('todo.title')}
      tabIndex={0}
    >
      <div
        className={styles.summary}
        aria-label={t('todo.stepProgress', {
          current: stepIndex,
          total,
        })}
      >
        <span
          className={styles.progressRing}
          style={{ '--todo-progress': String(progress) } as CSSProperties}
          aria-hidden="true"
        />
        <span className={styles.stepText}>
          {t('todo.stepProgress', { current: stepIndex, total })}
        </span>
      </div>

      <div className={styles.detail} role="tooltip">
        {todos.map((todo, index) => (
          <div
            key={`${todo.id || index}:${todo.content}`}
            className={`${styles.item} ${getStatusClass(todo.status)}`}
          >
            <span className={styles.icon} aria-hidden="true">
              {getTodoStatusIcon(todo.status)}
            </span>
            <span className={styles.content} title={todo.content}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
});

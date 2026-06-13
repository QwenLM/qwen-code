import { memo } from 'react';
import type { TodoItem } from '../../adapters/types';
import { getTodoStatusIcon } from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './PlanMessage.module.css';

interface PlanMessageProps {
  todos: TodoItem[];
}

function getStatusClass(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return styles.completed;
    case 'in_progress':
      return styles.inProgress;
    case 'pending':
      return '';
  }
}

export const PlanMessage = memo(function PlanMessage({
  todos,
}: PlanMessageProps) {
  const { t } = useI18n();
  if (todos.length === 0) return null;

  // Size the number column to the widest index so the status markers stay
  // aligned once the list grows past 9 items.
  const numColumnWidth = `${String(todos.length).length + 1}ch`;

  return (
    <div className={styles.message}>
      <div className={styles.title}>{t('plan.title')}</div>
      <div className={styles.list}>
        {todos.map((todo, index) => (
          <div
            key={todo.id || index}
            className={`${styles.item} ${getStatusClass(todo.status)}`}
          >
            <span className={styles.num} style={{ minWidth: numColumnWidth }}>
              {index + 1}.
            </span>
            <span className={styles.marker}>
              {getTodoStatusIcon(todo.status)}
            </span>
            <span className={styles.content}>{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

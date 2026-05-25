import { memo } from 'react';
import type { TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import styles from './PlanMessage.module.css';

interface PlanMessageProps {
  todos: TodoItem[];
}

function markerForStatus(status: TodoItem['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'in_progress') return '→';
  return ' ';
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

  return (
    <div className={styles.message}>
      <div className={styles.title}>{t('plan.title')}</div>
      <div className={styles.list}>
        {todos.map((todo, index) => (
          <div
            key={todo.id || index}
            className={`${styles.item} ${getStatusClass(todo.status)}`}
          >
            <span className={styles.num}>{index + 1}.</span>
            <span className={styles.marker}>
              {markerForStatus(todo.status)}
            </span>
            <span className={styles.content}>{todo.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

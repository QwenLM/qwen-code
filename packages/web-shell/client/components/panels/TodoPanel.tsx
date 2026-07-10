import { memo } from 'react';
import type { CSSProperties } from 'react';
import type { TodoItem } from '../../adapters/types';
import type { WebShellBottomStatusItem } from '../../customization';
import { getTodoStatusIcon } from '../../utils/todos';
import { useI18n } from '../../i18n';
import styles from './TodoPanel.module.css';

interface TodoPanelProps {
  todos: TodoItem[];
  title?: string;
  statusItems?: readonly WebShellBottomStatusItem[];
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
  statusItems = [],
}: TodoPanelProps) {
  const { t } = useI18n();
  if (todos.length === 0 && statusItems.length === 0) return null;

  const total = todos.length;
  const hasTodos = total > 0;
  const inProgressIdx = todos.findIndex((td) => td.status === 'in_progress');
  const currentIdx =
    inProgressIdx >= 0
      ? inProgressIdx
      : todos.findIndex((td) => td.status === 'pending');
  const stepIndex = hasTodos ? (currentIdx >= 0 ? currentIdx + 1 : total) : 0;
  const progress = hasTodos ? stepIndex / total : 0;
  const statusOnlyLabel =
    statusItems
      .map(
        (item) =>
          item.ariaLabel ??
          item.title ??
          (typeof item.label === 'string' ? item.label : undefined),
      )
      .filter(Boolean)
      .join(', ') || undefined;
  const summaryAriaLabel = hasTodos
    ? t('todo.stepProgress', {
        current: stepIndex,
        total,
      })
    : statusOnlyLabel;

  return (
    <section
      className={styles.panel}
      aria-label={title ?? (hasTodos ? t('todo.title') : statusOnlyLabel)}
      tabIndex={0}
    >
      <div className={styles.summary} aria-label={summaryAriaLabel}>
        {hasTodos && (
          <>
            <span
              className={styles.progressRing}
              style={{ '--todo-progress': String(progress) } as CSSProperties}
              aria-hidden="true"
            />
            <span className={styles.stepText}>
              <span className={styles.fullText}>
                {t('todo.stepProgress', { current: stepIndex, total })}
              </span>
              <span className={styles.compactText}>
                {t('todo.stepFraction', { current: stepIndex, total })}
              </span>
            </span>
          </>
        )}
        {statusItems.map((item, index) => (
          <span key={item.id} className={styles.statusSegmentWrap}>
            {(total > 0 || index > 0) && (
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
            )}
            {item.onClick ? (
              <button
                type="button"
                className={styles.statusSegmentButton}
                title={item.title}
                aria-label={item.ariaLabel}
                onClick={item.onClick}
              >
                {item.label}
              </button>
            ) : (
              <span className={styles.statusSegment} title={item.title}>
                {item.label}
              </span>
            )}
          </span>
        ))}
      </div>

      {total > 0 && (
        <div className={styles.detail} role="tooltip">
          {todos.map((todo, index) => (
            <div
              key={`${todo.id || index}:${todo.content}`}
              className={`${styles.item} ${getStatusClass(todo.status)}`}
            >
              <span className={styles.icon} aria-hidden="true">
                {todo.status === 'in_progress' ? (
                  <span className={styles.loadingIcon} />
                ) : (
                  getTodoStatusIcon(todo.status)
                )}
              </span>
              <span className={styles.content} title={todo.content}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});

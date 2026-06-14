import { memo, useContext, useState } from 'react';
import type { TodoItem } from '../../adapters/types';
import { TodoTimelineContext } from '../../App';
import { TodoEventSummary, TodoFullList } from './TodoView';
import { useI18n } from '../../i18n';
import styles from './PlanMessage.module.css';

interface PlanMessageProps {
  id: string;
  todos: TodoItem[];
}

// Isolating the context read here (mirroring ToolGroup's TodoToolBody) keeps the
// memo-shielded PlanMessage from re-rendering when the timeline Map reference
// changes — only this small summary does.
function PlanEventSummary({ id, todos }: PlanMessageProps) {
  const timeline = useContext(TodoTimelineContext);
  const events = timeline.get(id)?.events ?? [];
  return <TodoEventSummary todos={todos} events={events} />;
}

export const PlanMessage = memo(function PlanMessage({
  id,
  todos,
}: PlanMessageProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (todos.length === 0) return null;

  const total = todos.length;
  const completed = todos.filter((td) => td.status === 'completed').length;

  return (
    <div className={styles.message}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        title={expanded ? t('todo.collapse') : t('todo.expand')}
      >
        <span className={styles.chevron} aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <span className={styles.title}>{t('plan.title')}</span>
        <span className={styles.progress}>
          {completed}/{total}
        </span>
      </button>
      {expanded ? (
        <TodoFullList todos={todos} numbered />
      ) : (
        <PlanEventSummary id={id} todos={todos} />
      )}
    </div>
  );
});

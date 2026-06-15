import { useContext, useState, type ReactNode } from 'react';
import type { TodoItem } from '../../adapters/types';
import {
  getTodoStatusIcon,
  todoStateKey,
  type TodoDetail,
  type TodoEvent,
} from '../../utils/todos';
import { TodoDetailContext } from '../../App';
import { formatTimestamp } from '../MessageTimestamp';
import { formatDuration } from './StatsMessage';
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

function DetailRow({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: ReactNode;
}) {
  // Two bare grid cells so every row's labels and values align in shared
  // columns within a section (see .detailRows).
  return (
    <>
      <span className={styles.detailLabel}>{label}</span>
      <span className={styles.detailValue}>
        {value}
        {suffix}
      </span>
    </>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.detailSection}>
      <div className={styles.detailSectionTitle}>{title}</div>
      <div className={styles.detailRows}>{children}</div>
    </div>
  );
}

/**
 * Timing and resource breakdown for one finished task, grouped into Time /
 * Tokens / Time-spent sections. Start/end come from the transcript so they show
 * even on a restored session. Token and time-spent rows render only for the
 * fields that were measured (tokens absent without stamped snapshots, API time
 * absent on resume, tool time absent when no tools ran); when nothing was
 * measured a short hint explains the absence.
 */
function TodoDetailBlock({ detail }: { detail: TodoDetail }) {
  const { t } = useI18n();
  const { startTs, endTs, resources } = detail;
  const hasTime = startTs !== undefined || endTs !== undefined;
  const hasTokens = resources?.inputTokens !== undefined;
  const hasSpent =
    resources?.apiTimeMs !== undefined || resources?.toolTimeMs !== undefined;
  return (
    <div className={styles.detail}>
      {hasTime && (
        <DetailSection title={t('todo.detail.sectionTime')}>
          {startTs !== undefined && (
            <DetailRow
              label={t('todo.detail.start')}
              value={formatTimestamp(startTs)}
            />
          )}
          {endTs !== undefined && (
            <DetailRow
              label={t('todo.detail.end')}
              value={formatTimestamp(endTs)}
              suffix={
                startTs !== undefined ? (
                  <span className={styles.detailDuration}>
                    {' '}
                    ({formatDuration(endTs - startTs)})
                  </span>
                ) : undefined
              }
            />
          )}
        </DetailSection>
      )}
      {hasTokens && (
        <DetailSection title={t('todo.detail.sectionTokens')}>
          <DetailRow
            label={t('todo.detail.input')}
            value={(resources?.inputTokens ?? 0).toLocaleString()}
          />
          <DetailRow
            label={t('todo.detail.output')}
            value={(resources?.outputTokens ?? 0).toLocaleString()}
          />
          <DetailRow
            label={t('todo.detail.cached')}
            value={(resources?.cachedTokens ?? 0).toLocaleString()}
          />
        </DetailSection>
      )}
      {hasSpent && (
        <DetailSection title={t('todo.detail.sectionSpent')}>
          {resources?.apiTimeMs !== undefined && (
            <DetailRow
              label={t('todo.detail.api')}
              value={formatDuration(resources.apiTimeMs)}
            />
          )}
          {resources?.toolTimeMs !== undefined && (
            <DetailRow
              label={t('todo.detail.tool')}
              value={formatDuration(resources.toolTimeMs)}
            />
          )}
        </DetailSection>
      )}
      {!resources && (
        <div className={styles.detailHint}>{t('todo.detail.noResources')}</div>
      )}
    </div>
  );
}

/**
 * Only finished tasks are expandable — `endTs` and `resources` are both set on
 * the completed transition, so either marks completion. An in_progress item
 * (which carries just `startTs`) stays a plain row, matching the feature's
 * focus on completed tasks and avoiding a half-empty detail panel mid-run.
 */
function hasTodoDetail(detail: TodoDetail | undefined): detail is TodoDetail {
  return (
    !!detail && (detail.endTs !== undefined || detail.resources !== undefined)
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
  const { t } = useI18n();
  const details = useContext(TodoDetailContext);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Size the number column to the widest index so the markers stay aligned once
  // the list grows past 9 items.
  const numColumnWidth = `${String(todos.length).length + 1}ch`;
  const toggle = (rowKey: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  return (
    <div className={styles.list}>
      {todos.map((todo, index) => {
        const rowKey = todo.id || String(index);
        const detail = details.get(todoStateKey(todo));
        const expandable = hasTodoDetail(detail);
        const isOpen = expandable && expanded.has(rowKey);
        const rowInner = (
          <>
            {numbered && (
              <span className={styles.num} style={{ minWidth: numColumnWidth }}>
                {index + 1}.
              </span>
            )}
            <span className={styles.icon} aria-hidden="true">
              {getTodoStatusIcon(todo.status)}
            </span>
            <span className={styles.text}>{todo.content}</span>
            {expandable && (
              <span className={styles.detailChevron} aria-hidden="true">
                {isOpen ? '▾' : '▸'}
              </span>
            )}
          </>
        );
        return (
          <div key={rowKey} className={styles.item}>
            {expandable ? (
              <button
                type="button"
                className={`${styles.row} ${styles.rowButton} ${statusClass(todo.status)}`}
                onClick={(e) => {
                  // This row toggles its own detail only — never bubble to a
                  // surrounding expandable container (e.g. the todo_write tool
                  // row, whose header would otherwise collapse the whole list).
                  e.stopPropagation();
                  toggle(rowKey);
                }}
                aria-expanded={isOpen}
                title={isOpen ? t('todo.detail.hide') : t('todo.detail.show')}
              >
                {rowInner}
              </button>
            ) : (
              <div className={`${styles.row} ${statusClass(todo.status)}`}>
                {rowInner}
              </div>
            )}
            {isOpen && detail && <TodoDetailBlock detail={detail} />}
          </div>
        );
      })}
    </div>
  );
}

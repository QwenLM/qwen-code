import { useMemo, useState } from 'react';
import { ResourceState } from '../common/ResourceState';
import type {
  WebTaskTimelineItem,
  WebTaskTimelineStatus,
} from './taskTimelineTypes';
import { useTaskTimeline } from './useTaskTimeline';

type TimelineFilter = 'all' | 'todos' | 'tools' | 'blocked' | 'errors';

const TIMELINE_FILTERS: Array<{ label: string; value: TimelineFilter }> = [
  { label: 'All activity', value: 'all' },
  { label: 'Todos', value: 'todos' },
  { label: 'Tools', value: 'tools' },
  { label: 'Needs action', value: 'blocked' },
  { label: 'Errors', value: 'errors' },
];

export function TaskTimelinePanel() {
  const { error, items, loading, source, summary } = useTaskTimeline();
  const [filter, setFilter] = useState<TimelineFilter>('all');

  const filteredItems = useMemo(
    () => items.filter((item) => matchesFilter(item, filter)),
    [filter, items],
  );

  return (
    <div className="web-panel task-timeline-panel">
      <div className="web-panel-header">
        <div>
          <h2>Task timeline</h2>
          <p>
            {filteredItems.length} / {items.length} events inferred from{' '}
            {source}
            {summary.activeTitle ? ` · Active: ${summary.activeTitle}` : ''}
          </p>
        </div>
      </div>

      <div className="task-summary-grid">
        <SummaryCard
          label="Total"
          value={summary.total}
          detail="timeline events"
        />
        <SummaryCard
          label="Running"
          value={summary.running}
          detail="active tool or todo work"
        />
        <SummaryCard
          label="Completed"
          value={summary.completed}
          detail="finished events"
        />
        <SummaryCard
          label="Needs attention"
          value={summary.blocked + summary.failed}
          detail={`${summary.blocked} blocked / ${summary.failed} failed`}
        />
      </div>

      <div className="web-filter-bar">
        <select
          aria-label="Filter task timeline"
          value={filter}
          onChange={(event) => setFilter(event.target.value as TimelineFilter)}
        >
          {TIMELINE_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="web-action-result">
        当前只从 Web transcript 推断任务流程；完整 workflow index 需要后续
        daemon API。
      </div>

      <ResourceState
        loading={loading}
        error={error}
        empty={filteredItems.length === 0}
        emptyText="No task timeline events match the current filter."
      >
        <ol className="task-timeline-list">
          {filteredItems.map((item) => (
            <TaskTimelineRow item={item} key={item.id} />
          ))}
        </ol>
      </ResourceState>
    </div>
  );
}

function SummaryCard({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: number;
}) {
  return (
    <div className="task-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function TaskTimelineRow({ item }: { item: WebTaskTimelineItem }) {
  return (
    <li className={`task-timeline-item task-status-${item.status}`}>
      <span className="task-timeline-marker" aria-hidden="true" />
      <article className="web-card task-timeline-card">
        <div className="web-card-main">
          <div className="task-timeline-title-row">
            <span className="task-status-badge">
              {statusLabel(item.status)}
            </span>
            <h3>{item.title}</h3>
          </div>
          <p>{item.detail ?? kindLabel(item.kind)}</p>
          <div className="web-meta">
            <span>{kindLabel(item.kind)}</span>
            <span>{formatTimelineTime(item.timestamp)}</span>
            {item.toolCallId ? <span>{item.toolCallId}</span> : null}
            {item.todoId ? <span>{item.todoId}</span> : null}
          </div>
        </div>
      </article>
    </li>
  );
}

function matchesFilter(item: WebTaskTimelineItem, filter: TimelineFilter) {
  switch (filter) {
    case 'todos':
      return item.kind === 'todo';
    case 'tools':
      return item.kind === 'tool';
    case 'blocked':
      return item.status === 'blocked' || item.status === 'pending';
    case 'errors':
      return item.status === 'failed' || item.status === 'cancelled';
    default:
      return true;
  }
}

function kindLabel(kind: WebTaskTimelineItem['kind']) {
  switch (kind) {
    case 'prompt':
      return 'Prompt';
    case 'todo':
      return 'Todo';
    case 'tool':
      return 'Tool';
    case 'permission':
      return 'Permission';
    default:
      return 'Status';
  }
}

function statusLabel(status: WebTaskTimelineStatus) {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'blocked':
      return 'Blocked';
    default:
      return 'Info';
  }
}

function formatTimelineTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

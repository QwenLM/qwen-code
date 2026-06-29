import type { WebTaskCheckResult } from '../task-timeline/taskTimelineTypes';
import type { WebTaskExecutionOverview } from './taskExecutionOverviewTypes';

export function TaskExecutionStatusCard({
  overview,
}: {
  overview: WebTaskExecutionOverview;
}) {
  const latestCheck = overview.checks[0];
  const attentionCount =
    overview.needsAttention.pendingPermissions +
    overview.needsAttention.failedTimelineItems +
    overview.needsAttention.errorNotices;

  return (
    <section
      className={`task-overview-card task-overview-${overview.status.severity}`}
    >
      <div className="task-overview-header">
        <div>
          <span>Current task</span>
          <strong>{overview.status.label}</strong>
        </div>
        {overview.status.detail ? <small>{overview.status.detail}</small> : null}
      </div>

      <div className="task-overview-grid">
        <OverviewMetric
          label="Todos"
          value={`${overview.progress.completedTodos}/${overview.progress.totalTodos}`}
        />
        <OverviewMetric label="Attention" value={`${attentionCount}`} />
        <OverviewMetric
          label="Changed"
          value={`${overview.changedArtifacts.length}`}
        />
      </div>

      {overview.progress.activeTodo ? (
        <p className="task-overview-muted">{overview.progress.activeTodo}</p>
      ) : null}

      {latestCheck ? <TaskCheckSummary check={latestCheck} /> : null}

      <div className="task-overview-repo">
        <span>Branch: {overview.repository.branch ?? 'unavailable'}</span>
        <span>Dirty: {formatDirty(overview.repository.dirty)}</span>
        <small>{overview.repository.detail}</small>
      </div>
    </section>
  );
}

function OverviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="task-overview-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskCheckSummary({ check }: { check: WebTaskCheckResult }) {
  return (
    <div className={`task-overview-check task-check-${check.status}`}>
      <span>{check.kind}</span>
      <strong>{check.status}</strong>
      {check.command ? <small>{check.command}</small> : null}
    </div>
  );
}

function formatDirty(value: boolean | undefined) {
  if (value === undefined) return 'unavailable';
  return value ? 'dirty' : 'clean';
}

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type {
  DaemonSessionWorkflowTaskStatus,
  DaemonWorkflowDispatchStatus,
  DaemonWorkflowDispatchStatusEntry,
} from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import { formatContextTokens } from '../../utils/formatTokenCount';
import { formatTimestamp } from '../MessageTimestamp';
import styles from './WorkflowExecutionView.module.css';

const LANE_WIDTH = 214;
const LANE_HEADER_HEIGHT = 54;
const NODE_WIDTH = 172;
const NODE_HEIGHT = 58;
const NODE_GAP = 22;
const CANVAS_PADDING = 22;
export const WORKFLOW_GRAPH_RENDER_LIMITS = {
  lanes: 64,
  nodes: 240,
  edges: 400,
} as const;
type WorkflowHistoryFilter = 'all' | 'completed' | 'failed' | 'cancelled';

interface WorkflowGraphNode {
  dispatch: DaemonWorkflowDispatchStatusEntry;
  x: number;
  y: number;
}

interface WorkflowGraphEdge {
  from: string;
  to: string;
  d: string;
}

export interface WorkflowGraphLayout {
  width: number;
  height: number;
  lanes: Array<{ id: string | null; title: string; index: number }>;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  dispatchCountByLaneId: ReadonlyMap<string | null, number>;
  dispatchStatusById: ReadonlyMap<string, DaemonWorkflowDispatchStatus>;
  omittedLanes: number;
  omittedNodes: number;
  omittedEdges: number;
}

export function buildWorkflowGraphLayout(
  task: DaemonSessionWorkflowTaskStatus,
): WorkflowGraphLayout {
  const hasUnphased = task.dispatches.some(
    (dispatch) => dispatch.phaseVisitId === null,
  );
  const phaseLaneLimit = Math.max(
    0,
    WORKFLOW_GRAPH_RENDER_LIMITS.lanes - (hasUnphased ? 1 : 0),
  );
  const lanes = [
    ...(hasUnphased ? [{ id: null, title: 'No phase', index: 0 }] : []),
    ...task.phaseVisits.slice(0, phaseLaneLimit).map((visit, index) => ({
      id: visit.id,
      title: visit.title,
      index: index + (hasUnphased ? 1 : 0),
    })),
  ];
  if (lanes.length === 0) lanes.push({ id: null, title: 'No phase', index: 0 });

  const laneIndexById = new Map(lanes.map((lane) => [lane.id, lane.index]));
  const dispatchCountByLaneId = new Map<string | null, number>();
  const dispatchStatusById = new Map<string, DaemonWorkflowDispatchStatus>();
  for (const dispatch of task.dispatches) {
    dispatchCountByLaneId.set(
      dispatch.phaseVisitId,
      (dispatchCountByLaneId.get(dispatch.phaseVisitId) ?? 0) + 1,
    );
    dispatchStatusById.set(dispatch.id, dispatch.status);
  }
  const rowByLane = new Map<number, number>();
  const nodes: WorkflowGraphNode[] = [];
  for (const dispatch of task.dispatches) {
    if (nodes.length >= WORKFLOW_GRAPH_RENDER_LIMITS.nodes) break;
    const laneIndex = laneIndexById.get(dispatch.phaseVisitId);
    if (laneIndex === undefined && dispatch.phaseVisitId !== null) continue;
    const visibleLaneIndex = laneIndex ?? 0;
    const row = rowByLane.get(visibleLaneIndex) ?? 0;
    rowByLane.set(visibleLaneIndex, row + 1);
    nodes.push({
      dispatch,
      x: visibleLaneIndex * LANE_WIDTH + CANVAS_PADDING,
      y: LANE_HEADER_HEIGHT + CANVAS_PADDING + row * (NODE_HEIGHT + NODE_GAP),
    });
  }
  const nodeById = new Map(nodes.map((node) => [node.dispatch.id, node]));
  const allDispatchIds = new Set(task.dispatches.map(({ id }) => id));
  let totalEdgeCount = 0;
  for (const dispatch of task.dispatches) {
    for (const dependencyId of dispatch.dependsOn) {
      if (allDispatchIds.has(dependencyId)) totalEdgeCount += 1;
    }
  }
  const edges: WorkflowGraphEdge[] = [];
  for (const target of nodes) {
    for (const dependencyId of target.dispatch.dependsOn) {
      if (edges.length >= WORKFLOW_GRAPH_RENDER_LIMITS.edges) break;
      const source = nodeById.get(dependencyId);
      if (!source) continue;
      const startX = source.x + NODE_WIDTH;
      const startY = source.y + NODE_HEIGHT / 2;
      const endX = target.x;
      const endY = target.y + NODE_HEIGHT / 2;
      const bend = Math.max(34, Math.abs(endX - startX) * 0.45);
      edges.push({
        from: dependencyId,
        to: target.dispatch.id,
        d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
      });
    }
  }
  const maxRows = Math.max(1, ...rowByLane.values());
  return {
    width: lanes.length * LANE_WIDTH,
    height:
      LANE_HEADER_HEIGHT +
      CANVAS_PADDING * 2 +
      maxRows * NODE_HEIGHT +
      Math.max(0, maxRows - 1) * NODE_GAP,
    lanes,
    nodes,
    edges,
    dispatchCountByLaneId,
    dispatchStatusById,
    omittedLanes: Math.max(
      0,
      task.phaseVisits.length + (hasUnphased ? 1 : 0) - lanes.length,
    ),
    omittedNodes: Math.max(0, task.dispatches.length - nodes.length),
    omittedEdges: Math.max(0, totalEdgeCount - edges.length),
  };
}

function statusLabel(
  status: DaemonWorkflowDispatchStatus,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return t(`workflow.dispatch.${status}`);
}

function statusGlyph(status: DaemonWorkflowDispatchStatus): string {
  if (status === 'completed' || status === 'cached') return '✓';
  if (status === 'failed') return '!';
  if (status === 'cancelled') return '×';
  return '';
}

function dispatchRuntime(
  task: DaemonSessionWorkflowTaskStatus,
  dispatch: DaemonWorkflowDispatchStatusEntry,
): string {
  if (dispatch.startedAt === undefined) return '—';
  const now = task.startTime + task.runtimeMs;
  return formatRuntime((dispatch.endedAt ?? now) - dispatch.startedAt);
}

function initialDispatchId(task: DaemonSessionWorkflowTaskStatus): string {
  const approvalSubagentIds = new Set(
    (task.pendingApprovals ?? []).map((approval) => approval.subagentId),
  );
  return (
    task.dispatches.find(
      (dispatch) =>
        dispatch.subagentId && approvalSubagentIds.has(dispatch.subagentId),
    )?.id ??
    task.dispatches.find((dispatch) => dispatch.status === 'failed')?.id ??
    task.dispatches.find((dispatch) => dispatch.status === 'running')?.id ??
    task.dispatches.find((dispatch) => dispatch.status === 'queued')?.id ??
    task.dispatches[0]?.id ??
    ''
  );
}

function downloadWorkflowHistory(
  task: DaemonSessionWorkflowTaskStatus,
  runs: readonly DaemonSessionWorkflowTaskStatus[],
): void {
  const content = JSON.stringify(
    {
      schemaVersion: 1,
      contextRunId: task.id,
      exportedAt: new Date().toISOString(),
      runs: runs.map((run) => ({
        id: run.id,
        sourceRunId: run.sourceRunId,
        startMode: run.startMode,
        status: run.status,
        startTime: run.startTime,
        endTime: run.endTime,
        runtimeMs: run.runtimeMs,
        phaseVisits: run.phaseVisits.map(
          ({ id, index, startedAt, endedAt }) => ({
            id,
            index,
            startedAt,
            endedAt,
          }),
        ),
        dispatches: run.dispatches.map(
          ({
            id,
            phaseVisitId,
            status,
            dependsOn,
            queuedAt,
            startedAt,
            endedAt,
          }) => ({
            id,
            phaseVisitId,
            status,
            dependsOn,
            queuedAt,
            startedAt,
            endedAt,
          }),
        ),
        agentsDispatched: run.agentsDispatched,
        agentsCompleted: run.agentsCompleted,
        tokensSpent: run.tokensSpent,
        tokenBudgetTotal: run.tokenBudgetTotal,
      })),
    },
    null,
    2,
  );
  const url = URL.createObjectURL(
    new Blob([content], { type: 'application/json' }),
  );
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `workflow-${task.id.replace(/[^a-zA-Z0-9._-]/g, '-')}-history.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function WorkflowExecutionView({
  task,
  sourceTask,
  historyTasks = [],
  historyActionBusy = false,
  onDeleteHistory,
}: {
  task: DaemonSessionWorkflowTaskStatus;
  sourceTask?: DaemonSessionWorkflowTaskStatus;
  historyTasks?: readonly DaemonSessionWorkflowTaskStatus[];
  historyActionBusy?: boolean;
  onDeleteHistory?: (runId: string) => void;
}) {
  const { t } = useI18n();
  const markerId = `workflow-arrow-${useId().replaceAll(':', '')}`;
  const layout = useMemo(() => buildWorkflowGraphLayout(task), [task]);
  const [selectedId, setSelectedId] = useState(() => initialDispatchId(task));
  const [hoveredDispatchId, setHoveredDispatchId] = useState('');
  const [focusedDispatchId, setFocusedDispatchId] = useState('');
  const [showComparison, setShowComparison] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] =
    useState<WorkflowHistoryFilter>('all');
  const [pendingDeleteRunId, setPendingDeleteRunId] = useState('');
  const [comparisonRunId, setComparisonRunId] = useState(
    () => task.sourceRunId ?? '',
  );
  const latestApprovalIdRef = useRef(task.pendingApprovals?.at(-1)?.approvalId);
  const lastPhaseVisit = task.phaseVisits.at(-1);
  const activePhaseVisitId =
    lastPhaseVisit?.endedAt === undefined ? lastPhaseVisit?.id : undefined;

  useEffect(() => {
    if (task.dispatches.some((dispatch) => dispatch.id === selectedId)) return;
    setSelectedId(initialDispatchId(task));
  }, [selectedId, task]);

  useEffect(() => {
    setShowComparison(false);
    setShowHistory(false);
    setHistoryFilter('all');
    setPendingDeleteRunId('');
    setComparisonRunId(task.sourceRunId ?? '');
    setHoveredDispatchId('');
    setFocusedDispatchId('');
  }, [task.id, task.sourceRunId]);

  useEffect(() => {
    const latest = task.pendingApprovals?.at(-1);
    if (!latest || latest.approvalId === latestApprovalIdRef.current) return;
    latestApprovalIdRef.current = latest.approvalId;
    const owner = task.dispatches.find(
      (dispatch) => dispatch.subagentId === latest.subagentId,
    );
    if (owner) setSelectedId(owner.id);
  }, [task.dispatches, task.pendingApprovals]);

  const selected =
    task.dispatches.find((dispatch) => dispatch.id === selectedId) ?? null;
  const emphasizedDispatchId = hoveredDispatchId || focusedDispatchId;
  const emphasizedDispatchIds = useMemo(() => {
    const related = new Set<string>();
    if (!emphasizedDispatchId) return related;
    related.add(emphasizedDispatchId);
    for (const edge of layout.edges) {
      if (edge.from === emphasizedDispatchId) related.add(edge.to);
      if (edge.to === emphasizedDispatchId) related.add(edge.from);
    }
    return related;
  }, [emphasizedDispatchId, layout.edges]);
  const approvalBySubagentId = new Map(
    (task.pendingApprovals ?? []).map((approval) => [
      approval.subagentId,
      approval,
    ]),
  );
  const selectedApproval = selected?.subagentId
    ? approvalBySubagentId.get(selected.subagentId)
    : undefined;
  const labelById = new Map(
    task.dispatches.map((dispatch) => [dispatch.id, dispatch.label]),
  );
  const running = task.dispatches.filter(
    (dispatch) => dispatch.status === 'running',
  ).length;
  const queued = task.dispatches.filter(
    (dispatch) => dispatch.status === 'queued',
  ).length;
  const cached = task.dispatches.filter(
    (dispatch) => dispatch.status === 'cached',
  ).length;
  const tokenText = task.tokenBudgetTotal
    ? `${formatContextTokens(task.tokensSpent)} / ${formatContextTokens(task.tokenBudgetTotal)}`
    : formatContextTokens(task.tokensSpent);
  const historicalRuns = useMemo(() => {
    const byId = new Map<string, DaemonSessionWorkflowTaskStatus>();
    if (sourceTask && sourceTask.id !== task.id) {
      byId.set(sourceTask.id, sourceTask);
    }
    for (const historicalTask of historyTasks) {
      if (historicalTask.id !== task.id) {
        byId.set(historicalTask.id, historicalTask);
      }
    }
    return [...byId.values()].sort((a, b) => b.startTime - a.startTime);
  }, [historyTasks, sourceTask, task.id]);
  const filteredHistoricalRuns = historicalRuns.filter(
    (historicalTask) =>
      historyFilter === 'all' || historicalTask.status === historyFilter,
  );
  const comparableSource = historicalRuns.find(
    (historicalTask) => historicalTask.id === task.sourceRunId,
  );
  const comparisonTask =
    historicalRuns.find(
      (historicalTask) => historicalTask.id === comparisonRunId,
    ) ?? comparableSource;
  const hasLineage = Boolean(task.sourceRunId && task.startMode);
  const history = (task.isHistorical ||
    hasLineage ||
    historicalRuns.length > 0) && (
    <>
      <div className={styles.historyBar}>
        <div className={styles.historyLead}>
          <span>
            {hasLineage
              ? t(
                  task.startMode === 'retry'
                    ? 'workflow.history.retry'
                    : 'workflow.history.rerun',
                  { runId: task.sourceRunId ?? '' },
                )
              : task.isHistorical
                ? t('workflow.history.restored')
                : t('workflow.history.saved', {
                    count: historicalRuns.length,
                  })}
          </span>
          {cached > 0 && (
            <span className={styles.cachedBadge}>
              {t('workflow.history.cached', { count: cached })}
            </span>
          )}
        </div>
        <div className={styles.historyActions}>
          {task.isHistorical && onDeleteHistory && (
            <button
              type="button"
              className={
                pendingDeleteRunId === task.id
                  ? styles.confirmDeleteButton
                  : styles.compareButton
              }
              disabled={historyActionBusy}
              onClick={() => {
                if (pendingDeleteRunId !== task.id) {
                  setPendingDeleteRunId(task.id);
                  return;
                }
                onDeleteHistory(task.id);
              }}
            >
              {pendingDeleteRunId === task.id
                ? t('workflow.history.confirmDelete')
                : t('workflow.history.deleteSaved')}
            </button>
          )}
          {historicalRuns.length > 0 && (
            <button
              type="button"
              className={styles.compareButton}
              aria-expanded={showHistory}
              onClick={() => setShowHistory((visible) => !visible)}
            >
              {showHistory
                ? t('workflow.history.hideRuns')
                : t('workflow.history.showRuns', {
                    count: historicalRuns.length,
                  })}
            </button>
          )}
          {comparableSource && (
            <button
              type="button"
              className={styles.compareButton}
              aria-expanded={
                showComparison && comparisonTask?.id === comparableSource.id
              }
              onClick={() => {
                setComparisonRunId(comparableSource.id);
                setShowComparison(
                  !showComparison || comparisonTask?.id !== comparableSource.id,
                );
              }}
            >
              {showComparison && comparisonTask?.id === comparableSource.id
                ? t('workflow.history.hideComparison')
                : t('workflow.history.compare')}
            </button>
          )}
        </div>
      </div>
      {showHistory && historicalRuns.length > 0 && (
        <div className={styles.historyLedger} data-run-history>
          <div className={styles.historyTools}>
            <label>
              <span>{t('workflow.history.filter')}</span>
              <select
                value={historyFilter}
                aria-label={t('workflow.history.filter')}
                onChange={(event) =>
                  setHistoryFilter(event.target.value as WorkflowHistoryFilter)
                }
              >
                <option value="all">{t('workflow.history.filterAll')}</option>
                <option value="completed">{t('tasks.completed')}</option>
                <option value="failed">{t('tasks.failed')}</option>
                <option value="cancelled">{t('tasks.cancelled')}</option>
              </select>
            </label>
            <span>
              {t('workflow.history.visibleCount', {
                count: filteredHistoricalRuns.length,
                total: historicalRuns.length,
              })}
            </span>
            <button
              type="button"
              className={styles.compareButton}
              disabled={filteredHistoricalRuns.length === 0}
              onClick={() =>
                downloadWorkflowHistory(task, filteredHistoricalRuns)
              }
            >
              {t('workflow.history.exportVisible')}
            </button>
          </div>
          {filteredHistoricalRuns.length === 0 ? (
            <div className={styles.historyEmpty}>
              {t('workflow.history.filterEmpty')}
            </div>
          ) : (
            filteredHistoricalRuns.map((historicalTask) => (
              <div
                key={historicalTask.id}
                className={styles.historyRun}
                data-status={historicalTask.status}
                data-selected={
                  showComparison && comparisonTask?.id === historicalTask.id
                }
              >
                <button
                  type="button"
                  className={styles.historyRunSelect}
                  data-history-run={historicalTask.id}
                  aria-pressed={
                    showComparison && comparisonTask?.id === historicalTask.id
                  }
                  aria-label={t('workflow.history.compareRun', {
                    runId: historicalTask.id,
                  })}
                  onClick={() => {
                    const isCurrentComparison =
                      showComparison &&
                      comparisonTask?.id === historicalTask.id;
                    setComparisonRunId(historicalTask.id);
                    setShowComparison(!isCurrentComparison);
                  }}
                >
                  <span className={styles.historyRunIdentity}>
                    <code>{historicalTask.id}</code>
                    <small>{formatTimestamp(historicalTask.startTime)}</small>
                  </span>
                  <span className={styles.historyRunStatus}>
                    {t(`tasks.${historicalTask.status}`)}
                  </span>
                  <span>{formatRuntime(historicalTask.runtimeMs)}</span>
                  <span>
                    {historicalTask.agentsCompleted}/
                    {historicalTask.agentsDispatched}
                  </span>
                  <span>{formatContextTokens(historicalTask.tokensSpent)}</span>
                </button>
                {historicalTask.isHistorical && onDeleteHistory && (
                  <button
                    type="button"
                    className={
                      pendingDeleteRunId === historicalTask.id
                        ? styles.confirmDeleteButton
                        : styles.historyDeleteButton
                    }
                    disabled={historyActionBusy}
                    onClick={() => {
                      if (pendingDeleteRunId !== historicalTask.id) {
                        setPendingDeleteRunId(historicalTask.id);
                        return;
                      }
                      onDeleteHistory(historicalTask.id);
                    }}
                  >
                    {pendingDeleteRunId === historicalTask.id
                      ? t('workflow.history.confirmDelete')
                      : t('workflow.history.delete')}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {showComparison && comparisonTask && (
        <div className={styles.comparison} data-run-comparison>
          <span className={styles.comparisonMetric} />
          <div className={styles.comparisonRun}>
            <strong>
              {comparisonTask.id === task.sourceRunId
                ? t('workflow.history.source')
                : t('workflow.history.compared')}
            </strong>
            <code>{comparisonTask.id}</code>
          </div>
          <div className={styles.comparisonRun}>
            <strong>{t('workflow.history.current')}</strong>
            <code>{task.id}</code>
          </div>

          <span className={styles.comparisonMetric}>
            {t('workflow.history.status')}
          </span>
          <span
            className={styles.comparisonValue}
            data-status={comparisonTask.status}
          >
            {t(`tasks.${comparisonTask.status}`)}
          </span>
          <span className={styles.comparisonValue} data-status={task.status}>
            {t(`tasks.${task.status}`)}
          </span>

          <span className={styles.comparisonMetric}>
            {t('tasks.detail.runtime')}
          </span>
          <span className={styles.comparisonValue}>
            {formatRuntime(comparisonTask.runtimeMs)}
          </span>
          <span className={styles.comparisonValue}>
            {formatRuntime(task.runtimeMs)}
          </span>

          <span className={styles.comparisonMetric}>
            {t('workflow.history.agents')}
          </span>
          <span className={styles.comparisonValue}>
            {comparisonTask.agentsCompleted}/{comparisonTask.agentsDispatched}
          </span>
          <span className={styles.comparisonValue}>
            {task.agentsCompleted}/{task.agentsDispatched}
          </span>

          <span className={styles.comparisonMetric}>
            {t('tasks.detail.tokenCount')}
          </span>
          <span className={styles.comparisonValue}>
            {formatContextTokens(comparisonTask.tokensSpent)}
          </span>
          <span className={styles.comparisonValue}>
            {formatContextTokens(task.tokensSpent)}
          </span>
        </div>
      )}
    </>
  );

  if (task.dispatches.length === 0) {
    return (
      <div className={styles.root} data-plan-interactive>
        {history}
        <div className={styles.empty}>
          {task.isHistorical
            ? t('workflow.graph.notRecorded')
            : t('workflow.graph.waiting')}
        </div>
      </div>
    );
  }

  return (
    <div
      className={styles.root}
      data-plan-interactive
      data-selected-dispatch={selected?.id}
    >
      {history}
      <div className={styles.summary} data-workflow-summary>
        <span>
          <strong>
            {task.agentsCompleted}/{task.agentsDispatched}
          </strong>{' '}
          {t('workflow.metric.agents')}
        </span>
        {running > 0 && (
          <span>
            <strong>{running}</strong> {t('workflow.metric.running')}
          </span>
        )}
        {queued > 0 && (
          <span>
            <strong>{queued}</strong> {t('workflow.metric.queued')}
          </span>
        )}
        <span>
          <strong>{tokenText}</strong> {t('workflow.metric.tokens')}
        </span>
        {task.pendingApprovalCount > 0 && (
          <span className={styles.approvalMetric}>
            <strong>{task.pendingApprovalCount}</strong>{' '}
            {t('workflow.approvalNeeded')}
          </span>
        )}
      </div>
      {(layout.omittedLanes > 0 ||
        layout.omittedNodes > 0 ||
        layout.omittedEdges > 0) && (
        <div
          className={styles.graphOmission}
          data-workflow-graph-omission
          role="status"
        >
          {t('workflow.graph.omitted', {
            lanes: layout.omittedLanes,
            nodes: layout.omittedNodes,
            edges: layout.omittedEdges,
          })}
        </div>
      )}
      <div className={styles.workbench}>
        <div className={styles.viewport}>
          <div
            className={styles.canvas}
            style={{
              width: `${layout.width}px`,
              height: `${layout.height}px`,
            }}
          >
            {layout.lanes.map((lane) => {
              const dispatchCount =
                layout.dispatchCountByLaneId.get(lane.id) ?? 0;
              return (
                <div
                  key={lane.id ?? 'no-phase'}
                  className={styles.lane}
                  data-workflow-lane={lane.id ?? 'no-phase'}
                  data-active={lane.id === activePhaseVisitId || undefined}
                  style={{
                    left: `${lane.index * LANE_WIDTH}px`,
                    width: `${LANE_WIDTH}px`,
                  }}
                >
                  <div className={styles.laneHeading}>
                    <span>{String(lane.index + 1).padStart(2, '0')}</span>
                    <strong>
                      {lane.id === null ? t('workflow.noPhase') : lane.title}
                    </strong>
                  </div>
                  <small>
                    {t('workflow.dispatchCount', { count: dispatchCount })}
                  </small>
                </div>
              );
            })}
            <svg
              className={styles.edges}
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const targetStatus = layout.dispatchStatusById.get(edge.to);
                const isRelated =
                  edge.from === emphasizedDispatchId ||
                  edge.to === emphasizedDispatchId;
                return (
                  <path
                    key={`${edge.from}:${edge.to}`}
                    d={edge.d}
                    className={styles.edge}
                    data-status={targetStatus}
                    data-workflow-edge={`${edge.from}:${edge.to}`}
                    data-path-emphasis={
                      emphasizedDispatchId
                        ? isRelated
                          ? 'related'
                          : 'dimmed'
                        : undefined
                    }
                    markerEnd={`url(#${markerId})`}
                  />
                );
              })}
            </svg>
            {layout.nodes.map(({ dispatch, x, y }) => {
              const approval = dispatch.subagentId
                ? approvalBySubagentId.get(dispatch.subagentId)
                : undefined;
              const pathEmphasis = emphasizedDispatchId
                ? dispatch.id === emphasizedDispatchId
                  ? 'active'
                  : emphasizedDispatchIds.has(dispatch.id)
                    ? 'related'
                    : 'dimmed'
                : undefined;
              return (
                <button
                  key={dispatch.id}
                  type="button"
                  className={styles.node}
                  data-status={dispatch.status}
                  data-workflow-dispatch={dispatch.id}
                  data-workflow-approval={approval?.approvalId}
                  data-path-emphasis={pathEmphasis}
                  aria-pressed={dispatch.id === selected?.id}
                  onClick={() => setSelectedId(dispatch.id)}
                  onMouseEnter={() => setHoveredDispatchId(dispatch.id)}
                  onMouseLeave={() => setHoveredDispatchId('')}
                  onFocus={() => {
                    setFocusedDispatchId(dispatch.id);
                    setSelectedId(dispatch.id);
                  }}
                  onBlur={() => setFocusedDispatchId('')}
                  style={
                    {
                      left: `${x}px`,
                      top: `${y}px`,
                      '--workflow-node-width': `${NODE_WIDTH}px`,
                      '--workflow-node-height': `${NODE_HEIGHT}px`,
                    } as CSSProperties
                  }
                >
                  <span className={styles.nodeState}>
                    {approval ? '?' : statusGlyph(dispatch.status)}
                  </span>
                  <span className={styles.nodeCopy}>
                    <strong>{dispatch.label}</strong>
                    <small>
                      {approval
                        ? t('workflow.approvalNeeded')
                        : statusLabel(dispatch.status, t)}
                    </small>
                  </span>
                  <span className={styles.nodeTime}>
                    {dispatchRuntime(task, dispatch)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {selected && (
          <aside className={styles.inspector}>
            <div className={styles.inspectorHeading}>
              <span>{t('workflow.selectedDispatch')}</span>
              <strong>{selected.label}</strong>
              <small data-status={selected.status}>
                {statusLabel(selected.status, t)}
              </small>
            </div>
            <p className={styles.inspectorPrompt} data-workflow-prompt>
              {selected.prompt}
            </p>
            {selectedApproval && (
              <div className={styles.approvalCallout}>
                <strong>{t('workflow.approvalNeeded')}</strong>
                <span>{selectedApproval.description}</span>
                <small>
                  {selectedApproval.name} · {t('workflow.respondInChat')}
                </small>
              </div>
            )}
            <dl>
              <div>
                <dt>{t('tasks.detail.runtime')}</dt>
                <dd>{dispatchRuntime(task, selected)}</dd>
              </div>
              <div>
                <dt>{t('workflow.dependencies')}</dt>
                <dd>
                  {selected.dependsOn.length > 0
                    ? selected.dependsOn
                        .map((id) => labelById.get(id) ?? id)
                        .join(', ')
                    : '—'}
                </dd>
              </div>
            </dl>
            {selected.error && (
              <div className={styles.dispatchError}>{selected.error}</div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

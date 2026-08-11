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
  DaemonWorkflowEvent,
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
const MAX_REPLAY_MARKERS = 160;
const REPLAY_OVERVIEW_MS = 6_000;

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

export type WorkflowReplayEventKind =
  | 'phase-started'
  | 'phase-completed'
  | 'dispatch-queued'
  | 'dispatch-started'
  | 'dispatch-completed'
  | 'dispatch-failed'
  | 'dispatch-cancelled'
  | 'dispatch-cached'
  | 'log'
  | 'approval-requested'
  | 'approval-settled'
  | 'workflow-completed'
  | 'workflow-failed'
  | 'workflow-cancelled';

export interface WorkflowReplayEvent {
  id: string;
  time: number;
  kind: WorkflowReplayEventKind;
  phaseVisitId?: string;
  dispatchId?: string;
  detail?: string;
}

export interface WorkflowReplayProjection {
  task: DaemonSessionWorkflowTaskStatus;
  futureDispatchIds: ReadonlySet<string>;
  futurePhaseVisitIds: ReadonlySet<string>;
  completedPhaseVisitIds: ReadonlySet<string>;
  activePhaseVisitId?: string;
  elapsedEventCount: number;
  totalEventCount: number;
}

function workflowReplayEnd(task: DaemonSessionWorkflowTaskStatus): number {
  return Math.max(
    task.startTime,
    task.endTime ?? task.startTime + task.runtimeMs,
  );
}

const REPLAY_EVENT_PRIORITY: Record<WorkflowReplayEventKind, number> = {
  'dispatch-completed': 0,
  'dispatch-failed': 0,
  'dispatch-cancelled': 0,
  'dispatch-cached': 4,
  'phase-completed': 1,
  'phase-started': 2,
  'dispatch-queued': 3,
  'dispatch-started': 4,
  log: 5,
  'approval-requested': 6,
  'approval-settled': 6,
  'workflow-completed': 7,
  'workflow-failed': 7,
  'workflow-cancelled': 7,
};

function replayEventFromLedger(
  event: DaemonWorkflowEvent,
): WorkflowReplayEvent {
  const base = { id: event.id, time: event.at, kind: event.type };
  switch (event.type) {
    case 'phase-started':
    case 'phase-completed':
      return { ...base, phaseVisitId: event.phaseVisitId };
    case 'dispatch-queued':
    case 'dispatch-started':
    case 'dispatch-completed':
    case 'dispatch-cancelled':
    case 'dispatch-cached':
      return { ...base, dispatchId: event.dispatchId };
    case 'dispatch-failed':
      return {
        ...base,
        dispatchId: event.dispatchId,
        detail: event.error,
      };
    case 'log':
      return { ...base, detail: event.message };
    case 'approval-requested':
    case 'approval-settled':
      return {
        ...base,
        dispatchId: event.dispatchId,
        detail: event.name,
      };
    case 'workflow-failed':
      return { ...base, detail: event.error };
    case 'workflow-completed':
    case 'workflow-cancelled':
      return base;
  }
}

function dispatchTerminalEventKind(
  status: DaemonWorkflowDispatchStatus,
): WorkflowReplayEventKind | undefined {
  if (status === 'completed') return 'dispatch-completed';
  if (status === 'failed') return 'dispatch-failed';
  if (status === 'cancelled') return 'dispatch-cancelled';
  if (status === 'cached') return 'dispatch-cached';
  return undefined;
}

export function buildWorkflowReplayEvents(
  task: DaemonSessionWorkflowTaskStatus,
): WorkflowReplayEvent[] {
  if (task.events !== undefined) {
    return task.events.map(replayEventFromLedger);
  }
  const events: WorkflowReplayEvent[] = [];
  for (const visit of task.phaseVisits) {
    events.push({
      id: `phase:${visit.id}:started`,
      time: visit.startedAt,
      kind: 'phase-started',
      phaseVisitId: visit.id,
    });
    if (visit.endedAt !== undefined) {
      events.push({
        id: `phase:${visit.id}:completed`,
        time: visit.endedAt,
        kind: 'phase-completed',
        phaseVisitId: visit.id,
      });
    }
  }
  for (const dispatch of task.dispatches) {
    events.push({
      id: `dispatch:${dispatch.id}:queued`,
      time: dispatch.queuedAt,
      kind: 'dispatch-queued',
      dispatchId: dispatch.id,
    });
    if (dispatch.startedAt !== undefined) {
      events.push({
        id: `dispatch:${dispatch.id}:started`,
        time: dispatch.startedAt,
        kind: 'dispatch-started',
        dispatchId: dispatch.id,
      });
    }
    const terminalKind = dispatchTerminalEventKind(dispatch.status);
    if (dispatch.endedAt !== undefined && terminalKind) {
      events.push({
        id: `dispatch:${dispatch.id}:${terminalKind.replace('dispatch-', '')}`,
        time: dispatch.endedAt,
        kind: terminalKind,
        dispatchId: dispatch.id,
        detail: dispatch.error,
      });
    }
  }
  for (const approval of task.pendingApprovals ?? []) {
    const dispatch = task.dispatches.find(
      (candidate) => candidate.subagentId === approval.subagentId,
    );
    events.push({
      id: `approval:${approval.approvalId}:requested`,
      time: approval.at,
      kind: 'approval-requested',
      dispatchId: dispatch?.id,
      detail: approval.description,
    });
  }
  if (
    task.endTime !== undefined &&
    (task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled')
  ) {
    events.push({
      id: `workflow:${task.id}:${task.status}`,
      time: task.endTime,
      kind: `workflow-${task.status}`,
      detail: task.error,
    });
  }
  return events.sort(
    (a, b) =>
      a.time - b.time ||
      REPLAY_EVENT_PRIORITY[a.kind] - REPLAY_EVENT_PRIORITY[b.kind] ||
      a.id.localeCompare(b.id),
  );
}

function sampledReplayEvents(
  events: readonly WorkflowReplayEvent[],
): readonly WorkflowReplayEvent[] {
  if (events.length <= MAX_REPLAY_MARKERS) return events;
  return Array.from({ length: MAX_REPLAY_MARKERS }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (events.length - 1)) / (MAX_REPLAY_MARKERS - 1),
    );
    return events[sourceIndex]!;
  });
}

function isTerminalWorkflow(task: DaemonSessionWorkflowTaskStatus): boolean {
  return (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled'
  );
}

export function projectWorkflowReplay(
  task: DaemonSessionWorkflowTaskStatus,
  replayAt: number,
): WorkflowReplayProjection {
  const replayEnd = workflowReplayEnd(task);
  const at = Math.min(replayEnd, Math.max(task.startTime, replayAt));
  const atEnd = at >= replayEnd;
  const futureDispatchIds = new Set<string>();
  const dispatches = task.dispatches.map((dispatch) => {
    if (atEnd) return dispatch;
    if (at < dispatch.queuedAt) {
      futureDispatchIds.add(dispatch.id);
      return {
        ...dispatch,
        status: 'queued' as const,
        startedAt: undefined,
        endedAt: undefined,
        error: undefined,
      };
    }
    if (dispatch.status === 'cached') return dispatch;
    if (dispatch.endedAt !== undefined && at >= dispatch.endedAt) {
      return dispatch;
    }
    if (dispatch.startedAt !== undefined && at >= dispatch.startedAt) {
      return {
        ...dispatch,
        status: 'running' as const,
        endedAt: undefined,
        error: undefined,
      };
    }
    return {
      ...dispatch,
      status: 'queued' as const,
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
    };
  });
  const futurePhaseVisitIds = new Set(
    task.phaseVisits
      .filter((visit) => visit.startedAt > at)
      .map((visit) => visit.id),
  );
  const completedPhaseVisitIds = new Set(
    task.phaseVisits
      .filter(
        (visit) =>
          (visit.endedAt !== undefined && visit.endedAt <= at) ||
          (atEnd && isTerminalWorkflow(task)),
      )
      .map((visit) => visit.id),
  );
  let activePhaseVisitId: string | undefined;
  if (!atEnd || !isTerminalWorkflow(task)) {
    for (let index = task.phaseVisits.length - 1; index >= 0; index -= 1) {
      const visit = task.phaseVisits[index]!;
      if (
        visit.startedAt <= at &&
        (visit.endedAt === undefined || at < visit.endedAt)
      ) {
        activePhaseVisitId = visit.id;
        break;
      }
    }
  }
  const events = buildWorkflowReplayEvents(task);
  const pendingApprovals = atEnd
    ? (task.pendingApprovals ?? [])
    : (task.pendingApprovals ?? []).filter((approval) => approval.at <= at);
  const recordedApprovalCount =
    task.events === undefined
      ? undefined
      : events.reduce((count, event) => {
          if (event.time > at) return count;
          if (event.kind === 'approval-requested') return count + 1;
          if (event.kind === 'approval-settled') return Math.max(0, count - 1);
          return count;
        }, 0);

  return {
    task: atEnd
      ? task
      : {
          ...task,
          status: 'running',
          endTime: undefined,
          runtimeMs: at - task.startTime,
          currentPhase:
            task.phaseVisits.find((visit) => visit.id === activePhaseVisitId)
              ?.title ?? null,
          dispatches,
          pendingApprovalCount:
            recordedApprovalCount ?? pendingApprovals.length,
          pendingApprovals,
        },
    futureDispatchIds,
    futurePhaseVisitIds,
    completedPhaseVisitIds,
    activePhaseVisitId,
    elapsedEventCount: events.filter((event) => event.time <= at).length,
    totalEventCount: events.length,
  };
}

function formatReplayTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const shortTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${shortTime}`
    : shortTime;
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

function replayEventCategory(
  kind: WorkflowReplayEventKind,
): 'phase' | 'dispatch' | 'log' | 'approval' | 'workflow' {
  if (kind.startsWith('phase-')) return 'phase';
  if (kind.startsWith('dispatch-')) return 'dispatch';
  if (kind === 'log') return 'log';
  if (kind.startsWith('approval-')) return 'approval';
  return 'workflow';
}

function replayEventLabel(
  kind: WorkflowReplayEventKind,
  t: ReturnType<typeof useI18n>['t'],
): string {
  return t(`workflow.replay.event.${kind}`);
}

function replayEventTitle(
  event: WorkflowReplayEvent,
  task: DaemonSessionWorkflowTaskStatus,
): string {
  if (event.dispatchId) {
    return (
      task.dispatches.find((dispatch) => dispatch.id === event.dispatchId)
        ?.label ?? event.dispatchId
    );
  }
  if (event.phaseVisitId) {
    return (
      task.phaseVisits.find((visit) => visit.id === event.phaseVisitId)
        ?.title ?? event.phaseVisitId
    );
  }
  return task.label;
}

function replayEventAt(
  events: readonly WorkflowReplayEvent[],
  replayAt: number,
  selectedEventId: string,
): WorkflowReplayEvent | undefined {
  const selected = events.find(
    (event) => event.id === selectedEventId && event.time === replayAt,
  );
  if (selected) return selected;
  let current: WorkflowReplayEvent | undefined;
  for (const event of events) {
    if (
      event.time <= replayAt &&
      (current === undefined || event.time >= current.time)
    ) {
      current = event;
    }
  }
  return current;
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
      workflow: task.label,
      exportedAt: new Date().toISOString(),
      runs: runs.map((run) => ({
        id: run.id,
        sourceRunId: run.sourceRunId,
        startMode: run.startMode,
        label: run.label,
        description: run.description,
        status: run.status,
        startTime: run.startTime,
        endTime: run.endTime,
        runtimeMs: run.runtimeMs,
        currentPhase: run.currentPhase,
        phaseVisits: run.phaseVisits,
        dispatches: run.dispatches,
        agentsDispatched: run.agentsDispatched,
        agentsCompleted: run.agentsCompleted,
        tokensSpent: run.tokensSpent,
        tokenBudgetTotal: run.tokenBudgetTotal,
        recentLogs: run.recentLogs,
        events: run.events,
        error: run.error,
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
  const replayStart = task.startTime;
  const replayEnd = workflowReplayEnd(task);
  const replayEvents = useMemo(() => buildWorkflowReplayEvents(task), [task]);
  const canReplay = Boolean(
    task.isHistorical && replayEvents.length > 0 && replayEnd > replayStart,
  );
  const [replayAt, setReplayAt] = useState(replayEnd);
  const replayAtRef = useRef(replayEnd);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [selectedReplayEventId, setSelectedReplayEventId] = useState('');
  const replayProjection = useMemo(
    () => (canReplay ? projectWorkflowReplay(task, replayAt) : undefined),
    [canReplay, replayAt, task],
  );
  const currentReplayEvent = useMemo(
    () => replayEventAt(replayEvents, replayAt, selectedReplayEventId),
    [replayAt, replayEvents, selectedReplayEventId],
  );
  const displayTask = replayProjection?.task ?? task;
  const layout = useMemo(
    () => buildWorkflowGraphLayout(displayTask),
    [displayTask],
  );
  const [selectedId, setSelectedId] = useState(() => initialDispatchId(task));
  const [showComparison, setShowComparison] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyFilter, setHistoryFilter] =
    useState<WorkflowHistoryFilter>('all');
  const [pendingDeleteRunId, setPendingDeleteRunId] = useState('');
  const [comparisonRunId, setComparisonRunId] = useState(
    () => task.sourceRunId ?? '',
  );
  const latestApprovalIdRef = useRef(task.pendingApprovals?.at(-1)?.approvalId);
  const lastPhaseVisit = displayTask.phaseVisits.at(-1);
  const activePhaseVisitId = replayProjection
    ? replayProjection.activePhaseVisitId
    : lastPhaseVisit?.endedAt === undefined
      ? lastPhaseVisit?.id
      : undefined;

  useEffect(() => {
    setIsReplayPlaying(false);
    setSelectedReplayEventId('');
    setReplayAt(replayEnd);
    replayAtRef.current = replayEnd;
  }, [replayEnd, task.id]);

  useEffect(() => {
    replayAtRef.current = replayAt;
  }, [replayAt]);

  useEffect(() => {
    if (!isReplayPlaying) return;
    const from = replayAtRef.current;
    const remaining = replayEnd - from;
    if (remaining <= 0) {
      setIsReplayPlaying(false);
      return;
    }
    const runDuration = replayEnd - replayStart;
    const playbackDuration = Math.max(
      250,
      (remaining / runDuration) * REPLAY_OVERVIEW_MS,
    );
    const startedAt = performance.now();
    let animationFrame = 0;
    const advance = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / playbackDuration);
      const next = from + remaining * progress;
      replayAtRef.current = next;
      setReplayAt(next);
      if (progress < 1) {
        animationFrame = requestAnimationFrame(advance);
      } else {
        setIsReplayPlaying(false);
      }
    };
    animationFrame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(animationFrame);
  }, [isReplayPlaying, replayEnd, replayStart]);

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
    displayTask.dispatches.find((dispatch) => dispatch.id === selectedId) ??
    null;
  const approvalBySubagentId = new Map(
    (displayTask.pendingApprovals ?? []).map((approval) => [
      approval.subagentId,
      approval,
    ]),
  );
  const selectedApproval = selected?.subagentId
    ? approvalBySubagentId.get(selected.subagentId)
    : undefined;
  const labelById = new Map(
    displayTask.dispatches.map((dispatch) => [dispatch.id, dispatch.label]),
  );
  const visibleDispatches = displayTask.dispatches.filter(
    (dispatch) => !replayProjection?.futureDispatchIds.has(dispatch.id),
  );
  const running = visibleDispatches.filter(
    (dispatch) => dispatch.status === 'running',
  ).length;
  const queued = visibleDispatches.filter(
    (dispatch) => dispatch.status === 'queued',
  ).length;
  const agentsDispatched = replayProjection
    ? visibleDispatches.length
    : task.agentsDispatched;
  const agentsCompleted = replayProjection
    ? visibleDispatches.filter(
        (dispatch) =>
          dispatch.status === 'completed' ||
          dispatch.status === 'failed' ||
          dispatch.status === 'cancelled' ||
          dispatch.status === 'cached',
      ).length
    : task.agentsCompleted;
  const cached = task.dispatches.filter(
    (dispatch) => dispatch.status === 'cached',
  ).length;
  const tokenText = task.tokenBudgetTotal
    ? `${formatContextTokens(task.tokensSpent)} / ${formatContextTokens(task.tokenBudgetTotal)}`
    : formatContextTokens(task.tokensSpent);
  const replayProgress = canReplay
    ? ((replayAt - replayStart) / (replayEnd - replayStart)) * 100
    : 100;
  const replayMarkers = sampledReplayEvents(replayEvents);
  const replayLogMessages = task.events
    ?.filter((event) => event.type === 'log')
    .map((event) => event.message);
  const hasTimedLogs = Boolean(
    replayLogMessages &&
      replayLogMessages.length === task.recentLogs.length &&
      replayLogMessages.every((line, index) => line === task.recentLogs[index]),
  );
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
          <span className={styles.historyMark} aria-hidden="true">
            ↳
          </span>
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
      {canReplay && replayProjection && (
        <section
          className={styles.replayBar}
          data-run-replay
          data-replay-at={Math.round(replayAt)}
          aria-label={t('workflow.replay.label')}
        >
          <div className={styles.replayMeta}>
            <strong>{t('workflow.replay.label')}</strong>
            <span className={styles.replayTime}>
              {formatReplayTime(replayAt - replayStart)} /{' '}
              {formatReplayTime(replayEnd - replayStart)}
            </span>
            <span className={styles.replayEventCount}>
              {t('workflow.replay.events', {
                count: replayProjection.elapsedEventCount,
                total: replayProjection.totalEventCount,
              })}
            </span>
          </div>
          <div className={styles.replayTransport}>
            <button
              type="button"
              className={styles.replayPlayButton}
              aria-label={
                isReplayPlaying
                  ? t('workflow.replay.pause')
                  : t('workflow.replay.play')
              }
              onClick={() => {
                if (isReplayPlaying) {
                  setIsReplayPlaying(false);
                  return;
                }
                setSelectedReplayEventId('');
                if (replayAtRef.current >= replayEnd) {
                  replayAtRef.current = replayStart;
                  setReplayAt(replayStart);
                }
                setIsReplayPlaying(true);
              }}
            >
              {isReplayPlaying
                ? t('workflow.replay.pause')
                : t('workflow.replay.play')}
            </button>
            <button
              type="button"
              className={styles.replayEndButton}
              aria-label={t('workflow.replay.end')}
              disabled={!isReplayPlaying && replayAt >= replayEnd}
              onClick={() => {
                setIsReplayPlaying(false);
                setSelectedReplayEventId('');
                replayAtRef.current = replayEnd;
                setReplayAt(replayEnd);
              }}
            >
              {t('workflow.replay.end')}
            </button>
          </div>
          <div className={styles.replayRail}>
            <div
              className={styles.replayProgress}
              style={{ width: `${replayProgress}%` }}
            />
            <div className={styles.replayMarkers}>
              {replayMarkers.map((event) => {
                const title = replayEventTitle(event, task);
                const label = replayEventLabel(event.kind, t);
                const time = formatReplayTime(event.time - replayStart);
                const accessibleLabel = t('workflow.replay.jumpToEvent', {
                  title,
                  event: label,
                  time,
                });
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={styles.replayMarker}
                    data-kind={replayEventCategory(event.kind)}
                    data-replay-event={event.id}
                    aria-label={accessibleLabel}
                    aria-pressed={currentReplayEvent?.id === event.id}
                    title={accessibleLabel}
                    onClick={() => {
                      setIsReplayPlaying(false);
                      setSelectedReplayEventId(event.id);
                      replayAtRef.current = event.time;
                      setReplayAt(event.time);
                      if (event.dispatchId) {
                        setSelectedId(event.dispatchId);
                      }
                    }}
                    style={{
                      left: `${((event.time - replayStart) / (replayEnd - replayStart)) * 100}%`,
                    }}
                  />
                );
              })}
            </div>
            <input
              type="range"
              min={replayStart}
              max={replayEnd}
              step="1"
              value={replayAt}
              aria-label={t('workflow.replay.timeline')}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                setIsReplayPlaying(false);
                setSelectedReplayEventId('');
                replayAtRef.current = next;
                setReplayAt(next);
              }}
            />
          </div>
          {currentReplayEvent && (
            <div
              className={styles.replayContext}
              data-replay-current-event={currentReplayEvent.id}
            >
              <time>
                {formatReplayTime(currentReplayEvent.time - replayStart)}
              </time>
              <span className={styles.replayContextCopy}>
                <strong>{replayEventTitle(currentReplayEvent, task)}</strong>
                <small>{replayEventLabel(currentReplayEvent.kind, t)}</small>
              </span>
              {currentReplayEvent.detail && (
                <span
                  className={styles.replayEventDetail}
                  data-severity={
                    currentReplayEvent.kind === 'dispatch-failed' ||
                    currentReplayEvent.kind === 'workflow-failed'
                      ? 'error'
                      : currentReplayEvent.kind === 'approval-requested'
                        ? 'warning'
                        : undefined
                  }
                >
                  {currentReplayEvent.detail}
                </span>
              )}
            </div>
          )}
          {replayAt >= replayEnd && task.recentLogs.length > 0 && (
            <details className={styles.replayOutput} data-replay-final-output>
              <summary>
                <span>{t('workflow.replay.finalOutput')}</span>
                <small>
                  {t('workflow.replay.outputLines', {
                    count: task.recentLogs.length,
                  })}{' '}
                  ·{' '}
                  {t(
                    hasTimedLogs
                      ? 'workflow.replay.logsTimed'
                      : 'workflow.replay.logsUntimed',
                  )}
                </small>
              </summary>
              {!hasTimedLogs && <p>{t('workflow.replay.logsUntimed')}</p>}
              <pre>{task.recentLogs.join('\n')}</pre>
            </details>
          )}
        </section>
      )}
      <div className={styles.summary} data-workflow-summary>
        <span>
          <strong>
            {agentsCompleted}/{agentsDispatched}
          </strong>{' '}
          {t('workflow.metric.agents')}
        </span>
        <span>
          <strong>{running}</strong> {t('workflow.metric.running')}
        </span>
        <span>
          <strong>{queued}</strong> {t('workflow.metric.queued')}
        </span>
        <span>
          <strong>{tokenText}</strong> {t('workflow.metric.tokens')}
        </span>
        {displayTask.pendingApprovalCount > 0 && (
          <span className={styles.approvalMetric}>
            <strong>{displayTask.pendingApprovalCount}</strong>{' '}
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
                  data-replay-future={
                    (lane.id !== null &&
                      replayProjection?.futurePhaseVisitIds.has(lane.id)) ||
                    undefined
                  }
                  data-replay-completed={
                    (lane.id !== null &&
                      replayProjection?.completedPhaseVisitIds.has(lane.id)) ||
                    undefined
                  }
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
                const isFuture =
                  replayProjection?.futureDispatchIds.has(edge.from) ||
                  replayProjection?.futureDispatchIds.has(edge.to);
                return (
                  <path
                    key={`${edge.from}:${edge.to}`}
                    d={edge.d}
                    className={styles.edge}
                    data-status={targetStatus}
                    data-replay-future={isFuture || undefined}
                    data-workflow-edge={`${edge.from}:${edge.to}`}
                    markerEnd={`url(#${markerId})`}
                  />
                );
              })}
            </svg>
            {layout.nodes.map(({ dispatch, x, y }) => {
              const approval = dispatch.subagentId
                ? approvalBySubagentId.get(dispatch.subagentId)
                : undefined;
              return (
                <button
                  key={dispatch.id}
                  type="button"
                  className={styles.node}
                  data-status={dispatch.status}
                  data-workflow-dispatch={dispatch.id}
                  data-replay-future={
                    replayProjection?.futureDispatchIds.has(dispatch.id) ||
                    undefined
                  }
                  data-workflow-approval={approval?.approvalId}
                  aria-pressed={dispatch.id === selected?.id}
                  onClick={() => setSelectedId(dispatch.id)}
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
                    {dispatchRuntime(displayTask, dispatch)}
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
            <p>{selected.prompt}</p>
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
                <dd>{dispatchRuntime(displayTask, selected)}</dd>
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

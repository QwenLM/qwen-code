import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { useI18n } from '../../i18n';
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import { formatRuntime } from '../../utils/formatRuntime';
import { getAgentDescription, sanitizeControlChars } from './toolFormatting';
import {
  executionStatus,
  nestedAgentToolsForTool,
  nestedTasksFromIndex,
  taskForTool,
  toolForNestedTask,
  type PlanNodeStatus,
} from './taskExecutionIndex';
import type { SessionWorkflowProjection } from '../workflow/session-workflow-model';
import { buildSessionWorkflowProjection } from '../workflow/session-workflow-model';
import styles from './PlanExecutionView.module.css';

// The task-execution lookups this view used to own now live in
// `taskExecutionIndex` so the workflow projection can share them without a
// circular import. Re-exported here to keep this module's public surface
// stable for its existing importers (tests included).
export {
  createTaskExecutionIndex,
  getActiveAgents,
  getActiveAgentsFromIndex,
  getAttentionAgentStatuses,
  getAttentionAgentTool,
  getPlanNodeState,
  getPlanNodeStateFromIndex,
  nestedAgentToolsForTool,
  nestedTasksFromIndex,
  nestedTasksForTool,
  todoIdOf,
} from './taskExecutionIndex';
export type { PlanNodeStatus, TaskExecutionIndex } from './taskExecutionIndex';

interface PlanEdgePath {
  from: string;
  to: string;
  d: string;
}

interface PlanGraphLayout {
  width: number;
  height: number;
  edges: PlanEdgePath[];
  /**
   * How many stacked return lanes the layer-spanning edges needed. The canvas
   * reserves bottom padding for them so a lane never runs under a node.
   */
  lanes: number;
}

const EMPTY_GRAPH_LAYOUT: PlanGraphLayout = {
  width: 1,
  height: 1,
  edges: [],
  lanes: 0,
};

/** Vertical distance between two stacked layer-spanning return lanes. */
const EDGE_LANE_HEIGHT = 9;
/** Corner radius where an orthogonal edge turns. */
const EDGE_CORNER = 6;

const MAX_RENDERED_PLAN_EDGES = 500;

/**
 * Status is carried by a glyph as well as a colour so the graph survives
 * colour-blindness, high-contrast mode, and a greyscale screenshot. Every
 * surface showing plan status uses the same glyph for the same status.
 */
export const PLAN_STATUS_GLYPH: Record<PlanNodeStatus, string> = {
  blocked: '\u22ef',
  ready: '\u25cb',
  in_progress: '\u25d0',
  running: '\u25d0',
  paused: '\u2016',
  completed: '\u2713',
};

export function layerPlanTodos(todos: readonly TodoItem[]): TodoItem[][] {
  const byId = new Map(todos.map((todo) => [todo.id, todo]));
  const indegrees = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const depths = new Map<string, number>();

  for (const todo of byId.values()) {
    const dependencies = new Set(
      (todo.blockedBy ?? []).filter(
        (dependencyId) => dependencyId !== todo.id && byId.has(dependencyId),
      ),
    );
    indegrees.set(todo.id, dependencies.size);
    depths.set(todo.id, 0);
    for (const dependencyId of dependencies) {
      const children = dependents.get(dependencyId) ?? [];
      children.push(todo.id);
      dependents.set(dependencyId, children);
    }
  }

  const queue = [...byId.keys()].filter((id) => indegrees.get(id) === 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    const nextDepth = (depths.get(id) ?? 0) + 1;
    for (const dependentId of dependents.get(id) ?? []) {
      depths.set(
        dependentId,
        Math.max(depths.get(dependentId) ?? 0, nextDepth),
      );
      const remaining = (indegrees.get(dependentId) ?? 1) - 1;
      indegrees.set(dependentId, remaining);
      if (remaining === 0) queue.push(dependentId);
    }
  }

  let maxDepth = 0;
  for (const depth of depths.values()) maxDepth = Math.max(maxDepth, depth);
  for (const [id, remaining] of indegrees) {
    if (remaining > 0) depths.set(id, maxDepth + 1);
  }

  const layers: TodoItem[][] = [];
  for (const todo of todos) {
    const depth = depths.get(todo.id) ?? 0;
    (layers[depth] ??= []).push(todo);
  }
  return layers;
}

function statusKey(status: PlanNodeStatus) {
  return `planExecution.status.${status}` as const;
}

function executionStatusKey(status: string) {
  switch (status) {
    case 'running':
    case 'in_progress':
      return 'tasks.running';
    case 'paused':
      return 'tasks.paused';
    case 'completed':
      return 'tasks.completed';
    case 'failed':
      return 'tasks.failed';
    case 'cancelled':
      return 'tasks.cancelled';
    default:
      return 'planExecution.status.ready';
  }
}

export function PlanExecutionView({
  todos,
  tools,
  tasks,
  projection: sharedProjection,
  onOpenSubagent,
  hideTitle = false,
  selection,
  showStepDetails = true,
}: {
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  /**
   * A host that already derives the workflow projection (the cockpit, which
   * mounts this graph beside the inspector) passes its own, so the whole
   * surface shares one projection — and one task-execution index — per
   * render instead of each component privately rebuilding both. Standalone
   * mounts derive it from `todos` / `tools` / `tasks` here.
   */
  projection?: SessionWorkflowProjection;
  onOpenSubagent?: (tool: ACPToolCall) => void;
  /**
   * Drop the "Plan execution" caption when the host already titles the region.
   * The locate control stays either way — it is an action, not a label.
   */
  hideTitle?: boolean;
  /** Lets a larger host keep graph selection in sync with an adjacent detail surface. */
  selection?: {
    value: string | undefined;
    onChange: (todoId: string | undefined) => void;
  };
  /** The full Workflow canvas renders selected-step detail in the right panel. */
  showStepDetails?: boolean;
}) {
  const { t } = useI18n();
  const documentMode = useTranscriptRenderMode() === 'document';
  const projection = useMemo(
    () =>
      sharedProjection ?? buildSessionWorkflowProjection(todos, tools, tasks),
    [sharedProjection, tasks, todos, tools],
  );
  const taskIndex = projection.taskIndex;

  // Grouping, node states, counts and dependents all come from the shared
  // projection — one derivation per render across every workflow surface.
  // Only the graph-specific layering and topology serialization are derived
  // here, so a hover — which only flips `data-focused` / `data-active` —
  // re-renders without re-running the topological sort or the serialization.
  // `todos` arrives with a stable identity from `useStableArray`, and the
  // projection rebuilds whenever the transcript does, so the memo tracks
  // content rather than defeating itself on fresh array identities.
  const { todosById, toolsByTodo, states: statesByTodo } = projection;
  const unassigned = projection.unassignedTools;
  const completedCount = projection.completedCount;
  const progressPercent = projection.progressPercent;
  const activeAgentCount = projection.activeAgents.length;
  const attentionCount = projection.attentionTodos.length;
  const {
    topology,
    dependencyIdsByTodo,
    topologyKey,
    dependencyCount,
    hasDependencies,
    drawsDependencyEdges,
    layers,
    layerByTodo,
    dependentsByTodo,
  } = useMemo(() => {
    const topology = todos.map((todo): [string, string[]] => [
      todo.id,
      [...new Set(todo.blockedBy ?? [])].filter(
        (dependencyId) =>
          dependencyId !== todo.id && projection.todosById.has(dependencyId),
      ),
    ]);
    const dependencyIdsByTodo = new Map(topology);
    const topologyKey = JSON.stringify(topology);
    const dependencyCount = topology.reduce(
      (total, entry) => total + entry[1].length,
      0,
    );
    const hasDependencies = dependencyCount > 0;
    const drawsDependencyEdges =
      hasDependencies && dependencyCount <= MAX_RENDERED_PLAN_EDGES;
    const layers = hasDependencies ? layerPlanTodos(todos) : [todos.slice()];
    const layerByTodo = new Map<string, number>();
    const dependentsByTodo = new Map<string, string[]>();
    layers.forEach((layer, index) => {
      for (const todo of layer) layerByTodo.set(todo.id, index);
    });
    // Downstream step ids straight from the projection's own derivation —
    // the graph used to rebuild this from the topology it had just
    // serialized, a third copy of the same `blockedBy` walk (after the
    // projection's own and the one it replaced in the inspector).
    for (const [todoId, dependents] of projection.dependentsByTodo) {
      dependentsByTodo.set(
        todoId,
        dependents.map((dependent) => dependent.id),
      );
    }
    return {
      topology,
      dependencyIdsByTodo,
      topologyKey,
      dependencyCount,
      hasDependencies,
      drawsDependencyEdges,
      layers,
      layerByTodo,
      dependentsByTodo,
    };
  }, [projection, todos]);
  const graphId = useId().replaceAll(':', '');
  const markerId = `plan-arrow-${graphId}`;
  const dimMarkerId = `plan-arrow-dim-${graphId}`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const topologyRef = useRef(topology);
  topologyRef.current = topology;
  const layerByTodoRef = useRef(layerByTodo);
  layerByTodoRef.current = layerByTodo;
  const graphSignatureRef = useRef('');
  const autoLocatedTopologyRef = useRef('');
  const [graph, setGraph] = useState(EMPTY_GRAPH_LAYOUT);
  const [internalSelectedTodoId, setInternalSelectedTodoId] =
    useState<string>();
  const selectedTodoId = selection ? selection.value : internalSelectedTodoId;
  const updateSelectedTodoId = selection?.onChange ?? setInternalSelectedTodoId;
  const [hoveredTodoId, setHoveredTodoId] = useState<string>();
  // Hovering previews a step's dependency chain, selecting pins it. Both feed
  // one focus value so the highlight never fights itself.
  const focusedTodoId = hoveredTodoId ?? selectedTodoId;
  const focusTodoId =
    todos.find((todo) => {
      const status = statesByTodo.get(todo.id)?.status;
      return status === 'running' || status === 'in_progress';
    })?.id ??
    todos.find((todo) => todo.status !== 'completed')?.id ??
    todos[0]?.id;
  const locateFocusTodo = useCallback(
    (behavior: ScrollBehavior) => {
      const viewport = viewportRef.current;
      const node = focusTodoId ? nodeRefs.current.get(focusTodoId) : undefined;
      if (!viewport || !node) return;
      const viewportRect = viewport.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const left =
        viewport.scrollLeft +
        nodeRect.left -
        viewportRect.left -
        (viewport.clientWidth - nodeRect.width) / 2;
      // Mirror the horizontal computation vertically: on the fixed-height
      // workflow page a tall graph overflows the viewport downwards, and
      // scrollTo preserves scrollTop when only `left` is passed — the focused
      // step would stay out of view.
      const top =
        viewport.scrollTop +
        nodeRect.top -
        viewportRect.top -
        (viewport.clientHeight - nodeRect.height) / 2;
      // This runs inside a requestAnimationFrame, where a throw cannot be
      // caught by anything and takes the surrounding render down with it.
      // Centring the current step is a convenience; the plain assignment, or
      // skipping it, always beats an unhandled exception.
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ left, top, behavior });
      } else {
        viewport.scrollLeft = left;
        viewport.scrollTop = top;
      }
    },
    [focusTodoId],
  );

  useEffect(() => {
    if (selectedTodoId && !todos.some((todo) => todo.id === selectedTodoId)) {
      updateSelectedTodoId(undefined);
    }
  }, [selectedTodoId, todos, updateSelectedTodoId]);

  // A removed node never gets a pointerleave, so a stale hover id would keep
  // data-focused set with no edge matching it — dimming the whole graph.
  useEffect(() => {
    if (hoveredTodoId && !todos.some((todo) => todo.id === hoveredTodoId)) {
      setHoveredTodoId(undefined);
    }
  }, [hoveredTodoId, todos]);

  useEffect(() => {
    if (
      !hasDependencies ||
      !focusTodoId ||
      autoLocatedTopologyRef.current === topologyKey
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      locateFocusTodo('auto');
      autoLocatedTopologyRef.current = topologyKey;
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTodoId, hasDependencies, locateFocusTodo, topologyKey]);

  useLayoutEffect(() => {
    if (!drawsDependencyEdges) return;
    const graphElement = graphRef.current;
    if (!graphElement) return;

    const measure = () => {
      const graphRect = graphElement.getBoundingClientRect();
      const graphWidth = Math.max(1, graphElement.offsetWidth);
      const graphHeight = Math.max(1, graphElement.offsetHeight);
      const scaleX =
        graphElement.offsetWidth > 0
          ? graphRect.width / graphElement.offsetWidth
          : 1;
      const scaleY =
        graphElement.offsetHeight > 0
          ? graphRect.height / graphElement.offsetHeight
          : 1;
      const measuredNodes = new Map<string, DOMRect>();
      let maxNodeBottom = 0;
      for (const [todoId, node] of nodeRefs.current) {
        const rect = node.getBoundingClientRect();
        const normalizedRect = {
          ...rect,
          left: (rect.left - graphRect.left) / scaleX,
          right: (rect.right - graphRect.left) / scaleX,
          top: (rect.top - graphRect.top) / scaleY,
          bottom: (rect.bottom - graphRect.top) / scaleY,
          width: rect.width / scaleX,
          height: rect.height / scaleY,
        } as DOMRect;
        measuredNodes.set(todoId, normalizedRect);
        maxNodeBottom = Math.max(maxNodeBottom, normalizedRect.bottom);
      }
      const edges: PlanEdgePath[] = [];
      const spanning: Array<{
        from: string;
        to: string;
        startX: number;
        startY: number;
        endX: number;
        endY: number;
        span: number;
      }> = [];
      for (const [todoId, dependencies] of topologyRef.current) {
        const targetRect = measuredNodes.get(todoId);
        if (!targetRect) continue;
        for (const dependencyId of dependencies) {
          const sourceRect = measuredNodes.get(dependencyId);
          if (!sourceRect) continue;
          const startX = sourceRect.right + 4;
          const startY = sourceRect.top + sourceRect.height / 2;
          const endX = targetRect.left - 4;
          const endY = targetRect.top + targetRect.height / 2;
          const span =
            (layerByTodoRef.current.get(todoId) ?? 0) -
            (layerByTodoRef.current.get(dependencyId) ?? 0);
          if (span > 1) {
            spanning.push({
              from: dependencyId,
              to: todoId,
              startX,
              startY,
              endX,
              endY,
              span,
            });
            continue;
          }
          const controlX = startX + Math.max(24, (endX - startX) / 2);
          edges.push({
            from: dependencyId,
            to: todoId,
            d: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
          });
        }
      }
      // Layer-spanning edges all shared one routeY, so any plan with two long
      // dependencies drew them on top of each other. Give each its own lane,
      // ordered by span so the longest sits furthest out and the lanes nest
      // instead of crossing.
      spanning.sort((a, b) => a.span - b.span);
      spanning.forEach((edge, lane) => {
        const routeY = Math.min(
          maxNodeBottom + 14 + lane * EDGE_LANE_HEIGHT,
          Math.max(graphHeight - 6, maxNodeBottom + 14),
        );
        const dropX = edge.startX + 24;
        const riseX = edge.endX - 24;
        const down = routeY > edge.startY ? 1 : -1;
        const up = edge.endY > routeY ? 1 : -1;
        edges.push({
          from: edge.from,
          to: edge.to,
          d:
            `M ${edge.startX} ${edge.startY} ` +
            `H ${dropX - EDGE_CORNER} ` +
            `Q ${dropX} ${edge.startY} ${dropX} ${edge.startY + EDGE_CORNER * down} ` +
            `V ${routeY - EDGE_CORNER * down} ` +
            `Q ${dropX} ${routeY} ${dropX + EDGE_CORNER} ${routeY} ` +
            `H ${riseX - EDGE_CORNER} ` +
            `Q ${riseX} ${routeY} ${riseX} ${routeY + EDGE_CORNER * up} ` +
            `V ${edge.endY - EDGE_CORNER * up} ` +
            `Q ${riseX} ${edge.endY} ${riseX + EDGE_CORNER} ${edge.endY} ` +
            `H ${edge.endX}`,
        });
      });
      const next = {
        width: graphWidth,
        height: graphHeight,
        edges,
        lanes: spanning.length,
      };
      // Include edge identity in the signature: a re-issued plan revision
      // that renumbers step ids while preserving every step's geometry
      // produces identical path data, but the rendered edges carry from/to
      // for highlighting — skipping the state update would leave stale
      // identities wired to the wrong steps.
      const signature = `${next.width}:${next.height}:${next.lanes}:${edges.map((edge) => `${edge.from}>${edge.to}>${edge.d}`).join('|')}`;
      if (signature === graphSignatureRef.current) return;
      graphSignatureRef.current = signature;
      setGraph(next);
    };

    // Every node is observed and a window resize lands in the same frame as
    // the observer's own batch, so one viewport change ran `measure` many
    // times over — each run doing a getBoundingClientRect per node and
    // concatenating a signature across every edge. Coalesce to one run per
    // frame, which also lets the trailing run read a settled layout. The first
    // measure stays synchronous so the edges are present on the initial paint.
    let frame: number | undefined;
    let pending = false;
    const scheduleMeasure = () => {
      if (pending) return;
      pending = true;
      frame = requestAnimationFrame(() => {
        pending = false;
        measure();
      });
    };

    measure();
    window.addEventListener('resize', scheduleMeasure);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(scheduleMeasure);
    observer?.observe(graphElement);
    for (const node of nodeRefs.current.values()) observer?.observe(node);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', scheduleMeasure);
      observer?.disconnect();
    };
  }, [drawsDependencyEdges, topologyKey]);

  if (todos.length === 0) return null;

  const selectedTodo = todosById.get(selectedTodoId ?? '');
  const selectedExecutions = selectedTodo
    ? (toolsByTodo.get(selectedTodo.id) ?? [])
    : [];
  const selectedState = selectedTodo
    ? statesByTodo.get(selectedTodo.id)
    : undefined;
  const selectedDependents = selectedTodo
    ? (dependentsByTodo.get(selectedTodo.id) ?? [])
    : [];
  const detailsId = `plan-step-details-${graphId}`;
  const overallProgressId = `plan-overall-progress-${graphId}`;

  const renderExecution = (tool: ACPToolCall, expanded = false) => {
    const status = executionStatus(tool, taskIndex);
    const label = tool.title || String(tool.args?.description ?? tool.toolName);
    const liveTask = taskForTool(tool, taskIndex);
    const description = liveTask?.description || getAgentDescription(tool);
    const latestActivity = liveTask?.recentActivities?.at(-1);
    const metrics = liveTask
      ? [
          liveTask.startTime > 0 ? formatRuntime(liveTask.runtimeMs) : '',
          liveTask.stats?.toolUses === undefined
            ? ''
            : t('planExecution.toolCalls', {
                count: liveTask.stats.toolUses,
              }),
          liveTask.stats?.totalTokens === undefined
            ? ''
            : t('planExecution.tokens', {
                count: liveTask.stats.totalTokens.toLocaleString(),
              }),
        ].filter(Boolean)
      : [];
    const nestedTasks = nestedTasksFromIndex(tool, taskIndex);
    const transcriptNestedTools = nestedAgentToolsForTool(tool);
    const nestedToolByCallId = new Map(
      transcriptNestedTools.map(({ tool: nestedTool }) => [
        nestedTool.callId,
        nestedTool,
      ]),
    );
    const liveNestedCallIds = new Set(
      nestedTasks.flatMap(({ task }) =>
        task.toolUseId ? [task.toolUseId] : [],
      ),
    );
    const nestedTools = transcriptNestedTools.filter(
      ({ tool: nestedTool }) => !liveNestedCallIds.has(nestedTool.callId),
    );
    return (
      <div className={styles.executionGroup} key={tool.callId}>
        <button
          type="button"
          className={`${styles.execution}${
            expanded ? ` ${styles.executionExpanded}` : ''
          }`}
          data-plan-interactive
          onClick={() => onOpenSubagent?.(tool)}
          disabled={!onOpenSubagent}
          title={t('planExecution.openDetails')}
        >
          <span className={styles.executionHeading}>
            <span className={styles.executionLabel}>{label}</span>
            <span className={styles.executionStatus}>
              {t(executionStatusKey(status))}
            </span>
          </span>
          {expanded && description && (
            <span className={styles.executionDescription}>{description}</span>
          )}
          {expanded && latestActivity && (
            <span className={styles.executionActivity}>
              <span>{t('planExecution.currentActivity')}</span>
              {sanitizeControlChars(
                latestActivity.description || latestActivity.name,
              )}
            </span>
          )}
          {expanded && metrics.length > 0 && (
            <span className={styles.executionMetrics}>
              {metrics.join(' · ')}
            </span>
          )}
          {expanded && onOpenSubagent && (
            <span className={styles.executionOpen}>
              {t('planExecution.openDetails')} →
            </span>
          )}
        </button>
        {nestedTasks.map(({ task, depth }) => {
          const nestedTool = task.toolUseId
            ? (nestedToolByCallId.get(task.toolUseId) ??
              toolForNestedTask(task))
            : undefined;
          const content = (
            <>
              <span className={styles.executionLabel}>↳ {task.label}</span>
              <span className={styles.executionStatus}>
                {t(executionStatusKey(task.status))}
              </span>
            </>
          );
          return nestedTool ? (
            <button
              type="button"
              className={styles.nestedExecution}
              data-plan-interactive
              key={task.id}
              style={{ paddingLeft: `${Math.min(depth, 3) * 12}px` }}
              onClick={() => onOpenSubagent?.(nestedTool)}
              disabled={!onOpenSubagent}
              title={t('planExecution.openDetails')}
            >
              {content}
            </button>
          ) : (
            <div
              className={styles.nestedExecution}
              key={task.id}
              style={{ paddingLeft: `${Math.min(depth, 3) * 12}px` }}
            >
              {content}
            </div>
          );
        })}
        {nestedTools.map(({ tool: nestedTool, depth }) => (
          <button
            type="button"
            className={styles.nestedExecution}
            data-plan-interactive
            key={nestedTool.callId}
            style={{ paddingLeft: `${Math.min(depth, 3) * 12}px` }}
            onClick={() => onOpenSubagent?.(nestedTool)}
            disabled={!onOpenSubagent}
            title={t('planExecution.openDetails')}
          >
            <span className={styles.executionLabel}>
              ↳{' '}
              {nestedTool.title ||
                String(nestedTool.args?.description ?? nestedTool.toolName)}
            </span>
            <span className={styles.executionStatus}>
              {t(executionStatusKey(executionStatus(nestedTool, taskIndex)))}
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <section className={styles.section} aria-label={t('planExecution.title')}>
      {/* With the caption suppressed and nothing to locate there is no row
          left to draw, and an empty one still costs the section's row gap. */}
      {(!hideTitle || hasDependencies) && (
        <div
          className={styles.heading}
          data-title-hidden={hideTitle || undefined}
        >
          {!hideTitle && (
            <span>
              {t('planExecution.title')}{' '}
              <span className={styles.count}>({todos.length})</span>
            </span>
          )}
          {hasDependencies && (
            <button
              type="button"
              className={styles.locateButton}
              data-plan-interactive
              onClick={() => locateFocusTodo('smooth')}
            >
              {t('planExecution.locateCurrent')}
            </button>
          )}
        </div>
      )}
      <div className={styles.overviewContainer}>
        <div
          className={styles.overview}
          role="group"
          aria-label={t('planExecution.overview')}
        >
          <div className={styles.progressCard}>
            <div className={styles.progressHeading}>
              <span id={overallProgressId}>
                {t('planExecution.overallProgress')}
              </span>
              <strong>{progressPercent}%</strong>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-labelledby={overallProgressId}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            >
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
          <div className={styles.overviewStat}>
            <strong>
              {completedCount} / {todos.length}
            </strong>
            <span>{t('planExecution.stepsCompleted')}</span>
          </div>
          <div className={styles.overviewStat}>
            <strong>{activeAgentCount}</strong>
            <span>{t('planExecution.activeAgents')}</span>
          </div>
          <div
            className={styles.overviewStat}
            data-attention={attentionCount > 0 || undefined}
          >
            <strong>{attentionCount}</strong>
            <span>{t('planExecution.needsAttention')}</span>
          </div>
        </div>
      </div>
      {/* Past the edge budget the SVG is skipped entirely. The nodes still
          list what they depend on, but the lines vanishing with no explanation
          reads as a rendering failure, so say what happened. */}
      {hasDependencies && !drawsDependencyEdges && (
        <p className={styles.edgeNotice} role="status">
          {t('planExecution.edgesHidden', { count: dependencyCount })}
        </p>
      )}
      <div
        className={hasDependencies ? styles.dagViewport : styles.flatList}
        ref={hasDependencies ? viewportRef : undefined}
        {...(hasDependencies ? { 'data-plan-workflow': true } : {})}
      >
        <div
          className={hasDependencies ? styles.dagCanvas : styles.flatCanvas}
          ref={hasDependencies ? graphRef : undefined}
          style={
            hasDependencies
              ? ({ '--plan-edge-lanes': graph.lanes } as CSSProperties)
              : undefined
          }
        >
          {drawsDependencyEdges && graph.edges.length > 0 && (
            <svg
              className={styles.dagEdges}
              data-focused={focusedTodoId ? 'true' : undefined}
              width={graph.width}
              height={graph.height}
              viewBox={`0 0 ${graph.width} ${graph.height}`}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={markerId}
                  markerWidth="7"
                  markerHeight="7"
                  markerUnits="userSpaceOnUse"
                  refX="7"
                  refY="3.5"
                  orient="auto"
                >
                  <path
                    className={styles.edgeArrow}
                    d="M 0 0 L 7 3.5 L 0 7 z"
                  />
                </marker>
                {/* Marker contents inherit from the marker's own ancestors,
                    not from the path that references it, so a muted edge needs
                    its own arrowhead rather than inherited opacity. */}
                <marker
                  id={dimMarkerId}
                  markerWidth="7"
                  markerHeight="7"
                  markerUnits="userSpaceOnUse"
                  refX="7"
                  refY="3.5"
                  orient="auto"
                >
                  <path
                    className={styles.edgeArrowDim}
                    d="M 0 0 L 7 3.5 L 0 7 z"
                  />
                </marker>
              </defs>
              {graph.edges.map((edge) => {
                const active =
                  focusedTodoId === undefined ||
                  edge.from === focusedTodoId ||
                  edge.to === focusedTodoId;
                return (
                  <path
                    className={styles.dagEdge}
                    data-plan-edge
                    data-active={active || undefined}
                    data-from={edge.from}
                    data-to={edge.to}
                    d={edge.d}
                    key={`${edge.from}>${edge.to}`}
                    markerEnd={`url(#${active ? markerId : dimMarkerId})`}
                  />
                );
              })}
            </svg>
          )}
          {layers.map((layer, index) => (
            <div className={styles.layer} key={index}>
              {layer.map((todo) => {
                const executions = toolsByTodo.get(todo.id) ?? [];
                const state = statesByTodo.get(todo.id)!;
                return (
                  <article
                    className={styles.node}
                    data-status={state.status}
                    onPointerEnter={() => setHoveredTodoId(todo.id)}
                    onPointerLeave={() =>
                      setHoveredTodoId((current) =>
                        current === todo.id ? undefined : current,
                      )
                    }
                    // Tabbing through the graph traces the same chain a pointer
                    // does, so the highlight is not mouse-only.
                    onFocus={() => setHoveredTodoId(todo.id)}
                    onBlur={() =>
                      setHoveredTodoId((current) =>
                        current === todo.id ? undefined : current,
                      )
                    }
                    data-plan-input={
                      (drawsDependencyEdges &&
                        (dependencyIdsByTodo.get(todo.id)?.length ?? 0) > 0) ||
                      undefined
                    }
                    data-plan-output={
                      (drawsDependencyEdges &&
                        (dependentsByTodo.get(todo.id)?.length ?? 0) > 0) ||
                      undefined
                    }
                    data-selected={selectedTodoId === todo.id || undefined}
                    key={todo.id}
                    ref={(node) => {
                      if (node) nodeRefs.current.set(todo.id, node);
                      else nodeRefs.current.delete(todo.id);
                    }}
                  >
                    <button
                      type="button"
                      className={styles.nodeSummary}
                      data-plan-interactive
                      data-plan-node-id={todo.id}
                      aria-pressed={selectedTodoId === todo.id}
                      aria-expanded={
                        showStepDetails ? selectedTodoId === todo.id : undefined
                      }
                      aria-controls={
                        showStepDetails && selectedTodoId === todo.id
                          ? detailsId
                          : undefined
                      }
                      title={`${t(
                        showStepDetails && selectedTodoId === todo.id
                          ? 'todo.detail.hide'
                          : 'todo.detail.show',
                      )}: ${todo.content}`}
                      onClick={() =>
                        updateSelectedTodoId(
                          showStepDetails && selectedTodoId === todo.id
                            ? undefined
                            : todo.id,
                        )
                      }
                      disabled={documentMode}
                    >
                      <div className={styles.nodeTop}>
                        <i aria-hidden="true" className={styles.nodeGlyph}>
                          {PLAN_STATUS_GLYPH[state.status]}
                        </i>
                        <span className={styles.nodeId}>{todo.id}</span>
                        <span
                          className={`${styles.nodeStatus} ${styles[state.status]}`}
                        >
                          {t(statusKey(state.status))}
                        </span>
                        {state.attention && (
                          <span className={styles.attention}>
                            {t('planExecution.attention')}
                          </span>
                        )}
                      </div>
                      <div className={styles.nodeContent}>{todo.content}</div>
                      {(todo.blockedBy?.length ?? 0) > 0 && (
                        <div className={styles.dependencies}>
                          {t('planExecution.dependsOn')}{' '}
                          {todo.blockedBy!.join(', ')}
                        </div>
                      )}
                    </button>
                    {executions.length > 0 && (
                      <div className={styles.executions}>
                        {executions.map((tool) => renderExecution(tool))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {showStepDetails && selectedTodo && selectedState && (
        <section
          className={styles.stepDetails}
          data-plan-step-details
          id={detailsId}
          aria-label={`${t('planExecution.stepDetails')}: ${selectedTodo.id}`}
        >
          <div className={styles.stepDetailsHeading}>
            <span>{t('planExecution.stepDetails')}</span>
            <span className={styles.nodeId}>{selectedTodo.id}</span>
            <span
              className={`${styles.nodeStatus} ${styles[selectedState.status]}`}
            >
              {t(statusKey(selectedState.status))}
            </span>
            {selectedState.attention && (
              <span className={styles.attention}>
                {t('planExecution.attention')}
              </span>
            )}
          </div>
          <div className={styles.nodeContent}>{selectedTodo.content}</div>
          {(selectedTodo.blockedBy?.length ?? 0) > 0 && (
            <div className={styles.dependencies}>
              {t('planExecution.dependsOn')}{' '}
              {selectedTodo.blockedBy!.join(', ')}
            </div>
          )}
          {selectedDependents.length > 0 && (
            <div className={styles.dependencies}>
              {t('planExecution.unblocks')} {selectedDependents.join(', ')}
            </div>
          )}
          {selectedExecutions.length > 0 && (
            <div className={styles.stepExecutions}>
              <div className={styles.stepExecutionsTitle}>
                {t('planExecution.subagents')}
              </div>
              <div className={styles.executions}>
                {selectedExecutions.map((tool) => renderExecution(tool, true))}
              </div>
            </div>
          )}
          {selectedExecutions.length === 0 && (
            <div className={styles.emptyExecutions}>
              {t('planExecution.noSubagents')}
            </div>
          )}
        </section>
      )}
      {unassigned.length > 0 && (
        <div className={styles.unassigned}>
          <div className={styles.unassignedTitle}>
            {t('planExecution.unassigned')}
          </div>
          <div className={styles.executions}>
            {unassigned.map((tool) => renderExecution(tool))}
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
import { useI18n } from '../../i18n';
import { getAgentDisplayStatus, isAgentCancelled } from './toolFormatting';
import styles from './PlanExecutionView.module.css';

export type PlanNodeStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'in_progress'
  | 'ready';

interface PlanEdgePath {
  from: string;
  to: string;
  d: string;
}

interface PlanGraphLayout {
  width: number;
  height: number;
  edges: PlanEdgePath[];
}

const EMPTY_GRAPH_LAYOUT: PlanGraphLayout = {
  width: 1,
  height: 1,
  edges: [],
};

const MAX_RENDERED_PLAN_EDGES = 500;

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

function taskForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
) {
  return tasks.find(
    (task): task is DaemonSessionAgentTaskStatus =>
      task.kind === 'agent' && task.toolUseId === tool.callId,
  );
}

function executionStatus(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): string {
  const liveStatus = taskForTool(tool, tasks)?.status;
  if (liveStatus) return liveStatus;
  const persistedStatus =
    tool.rawOutput && typeof tool.rawOutput === 'object'
      ? (tool.rawOutput as Record<string, unknown>)['status']
      : undefined;
  if (persistedStatus === 'paused') return persistedStatus;
  return isAgentCancelled(tool) ? 'cancelled' : getAgentDisplayStatus(tool);
}

export function nestedTasksForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): Array<{ task: DaemonSessionAgentTaskStatus; depth: number }> {
  const root = taskForTool(tool, tasks);
  if (!root) return [];

  const children = new Map<string, DaemonSessionAgentTaskStatus[]>();
  for (const task of tasks) {
    if (task.kind !== 'agent' || task.parentAgentId == null) continue;
    const siblings = children.get(task.parentAgentId) ?? [];
    siblings.push(task);
    children.set(task.parentAgentId, siblings);
  }

  const result: Array<{
    task: DaemonSessionAgentTaskStatus;
    depth: number;
  }> = [];
  const visited = new Set([root.id]);
  const stack = (children.get(root.id) ?? [])
    .slice()
    .reverse()
    .map((task) => ({ task, depth: 1 }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.task.id)) continue;
    visited.add(entry.task.id);
    result.push(entry);
    const descendants = children.get(entry.task.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      stack.push({ task: descendants[index], depth: entry.depth + 1 });
    }
  }
  return result;
}

export function nestedAgentToolsForTool(
  tool: ACPToolCall,
): Array<{ tool: ACPToolCall; depth: number }> {
  const result: Array<{ tool: ACPToolCall; depth: number }> = [];
  const visit = (parent: ACPToolCall, depth: number) => {
    for (const child of parent.subTools ?? []) {
      if (!isSubAgentToolCall(child)) continue;
      result.push({ tool: child, depth });
      visit(child, depth + 1);
    }
  };
  visit(tool, 1);
  return result;
}

export function getPlanNodeState(
  todo: TodoItem,
  todosById: ReadonlyMap<string, TodoItem>,
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): { status: PlanNodeStatus; attention: boolean } {
  const executionStatuses = tools.map((tool) => executionStatus(tool, tasks));
  const descendantStatuses = tools.flatMap((tool) => [
    ...nestedTasksForTool(tool, tasks).map(({ task }) => task.status),
    ...nestedAgentToolsForTool(tool).map(({ tool: nestedTool }) =>
      executionStatus(nestedTool, tasks),
    ),
  ]);
  const attention = [...executionStatuses, ...descendantStatuses].some(
    (status) => status === 'failed' || status === 'cancelled',
  );
  if (
    executionStatuses.includes('running') ||
    executionStatuses.includes('in_progress')
  )
    return { status: 'running', attention };
  if (executionStatuses.includes('paused'))
    return { status: 'paused', attention };
  if (todo.status === 'completed') return { status: 'completed', attention };
  const blocked = (todo.blockedBy ?? []).some(
    (id) => todosById.get(id)?.status !== 'completed',
  );
  if (blocked) return { status: 'blocked', attention };
  if (todo.status === 'in_progress')
    return { status: 'in_progress', attention };
  return { status: 'ready', attention };
}

function todoIdOf(tool: ACPToolCall): string | undefined {
  const value = tool.args?.todo_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function toolForNestedTask(
  task: DaemonSessionAgentTaskStatus,
): ACPToolCall | undefined {
  if (!task.toolUseId) return undefined;
  const status: ACPToolCall['status'] =
    task.status === 'failed'
      ? 'failed'
      : task.status === 'running' || task.status === 'paused'
        ? 'in_progress'
        : 'completed';
  return {
    callId: task.toolUseId,
    toolName: 'Agent',
    title: task.label,
    args: { description: task.description },
    status,
    rawOutput: { type: 'task_execution', status: task.status },
  };
}

export function PlanExecutionView({
  todos,
  tools,
  tasks,
  onOpenSubagent,
}: {
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
  onOpenSubagent?: (tool: ACPToolCall) => void;
}) {
  const { t } = useI18n();

  const knownIds = new Set(todos.map((todo) => todo.id));
  const todosById = new Map(todos.map((todo) => [todo.id, todo]));
  const toolsByTodo = new Map<string, ACPToolCall[]>();
  const unassigned: ACPToolCall[] = [];
  for (const tool of tools) {
    const todoId = todoIdOf(tool);
    if (!todoId || !knownIds.has(todoId)) {
      unassigned.push(tool);
      continue;
    }
    const grouped = toolsByTodo.get(todoId) ?? [];
    grouped.push(tool);
    toolsByTodo.set(todoId, grouped);
  }
  const topology = todos.map((todo): [string, string[]] => [
    todo.id,
    [...new Set(todo.blockedBy ?? [])].filter(
      (dependencyId) => dependencyId !== todo.id && knownIds.has(dependencyId),
    ),
  ]);
  const topologyKey = JSON.stringify(topology);
  const dependencyCount = topology.reduce(
    (total, entry) => total + entry[1].length,
    0,
  );
  const hasDependencies = dependencyCount > 0;
  const hasTruncatedSubagentTree = tools.some(
    (tool) => tool.subToolsTruncated === true,
  );
  const drawsDependencyEdges =
    hasDependencies && dependencyCount <= MAX_RENDERED_PLAN_EDGES;
  const layers = hasDependencies ? layerPlanTodos(todos) : [todos.slice()];
  const layerByTodo = new Map<string, number>();
  layers.forEach((layer, index) => {
    for (const todo of layer) layerByTodo.set(todo.id, index);
  });
  const graphId = useId().replaceAll(':', '');
  const markerId = `plan-arrow-${graphId}`;
  const graphRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const topologyRef = useRef(topology);
  topologyRef.current = topology;
  const layerByTodoRef = useRef(layerByTodo);
  layerByTodoRef.current = layerByTodo;
  const graphSignatureRef = useRef('');
  const [graph, setGraph] = useState(EMPTY_GRAPH_LAYOUT);
  const [selectedTodoId, setSelectedTodoId] = useState<string>();

  useEffect(() => {
    if (selectedTodoId && !todos.some((todo) => todo.id === selectedTodoId)) {
      setSelectedTodoId(undefined);
    }
  }, [selectedTodoId, todos]);

  useLayoutEffect(() => {
    if (!drawsDependencyEdges) return;
    const graphElement = graphRef.current;
    if (!graphElement) return;

    const measure = () => {
      const graphRect = graphElement.getBoundingClientRect();
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
      for (const [todoId, dependencies] of topologyRef.current) {
        const targetRect = measuredNodes.get(todoId);
        if (!targetRect) continue;
        for (const dependencyId of dependencies) {
          const sourceRect = measuredNodes.get(dependencyId);
          if (!sourceRect) continue;
          const startX = sourceRect.right;
          const startY = sourceRect.top + sourceRect.height / 2;
          const endX = targetRect.left;
          const endY = targetRect.top + targetRect.height / 2;
          const spansLayers =
            (layerByTodoRef.current.get(todoId) ?? 0) -
              (layerByTodoRef.current.get(dependencyId) ?? 0) >
            1;
          const controlX = startX + Math.max(24, (endX - startX) / 2);
          const routeY = maxNodeBottom + 16;
          const d = spansLayers
            ? `M ${startX} ${startY} H ${startX + 28} V ${routeY} H ${endX - 28} V ${endY} H ${endX}`
            : `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`;
          edges.push({
            from: dependencyId,
            to: todoId,
            d,
          });
        }
      }
      const next = {
        width: Math.max(1, graphElement.scrollWidth, graphRect.width / scaleX),
        height: Math.max(
          1,
          graphElement.scrollHeight,
          graphRect.height / scaleY,
        ),
        edges,
      };
      const signature = `${next.width}:${next.height}:${edges.map((edge) => edge.d).join('|')}`;
      if (signature === graphSignatureRef.current) return;
      graphSignatureRef.current = signature;
      setGraph(next);
    };

    measure();
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(graphElement);
    for (const node of nodeRefs.current.values()) observer?.observe(node);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [drawsDependencyEdges, topologyKey]);

  if (todos.length === 0) return null;

  const selectedTodo = todosById.get(selectedTodoId ?? '');
  const selectedExecutions = selectedTodo
    ? (toolsByTodo.get(selectedTodo.id) ?? [])
    : [];
  const selectedState = selectedTodo
    ? getPlanNodeState(selectedTodo, todosById, selectedExecutions, tasks)
    : undefined;
  const detailsId = `plan-step-details-${graphId}`;

  const renderExecution = (tool: ACPToolCall) => {
    const status = executionStatus(tool, tasks);
    const label = tool.title || String(tool.args?.description ?? tool.toolName);
    const nestedTasks = nestedTasksForTool(tool, tasks);
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
          className={styles.execution}
          data-plan-interactive
          onClick={() => onOpenSubagent?.(tool)}
          disabled={!onOpenSubagent}
          title={t('planExecution.openDetails')}
        >
          <span className={styles.executionLabel}>{label}</span>
          <span className={styles.executionStatus}>
            {t(executionStatusKey(status))}
          </span>
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
              {t(executionStatusKey(executionStatus(nestedTool, tasks)))}
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <section className={styles.section} aria-label={t('planExecution.title')}>
      <div className={styles.heading}>
        {t('planExecution.title')}{' '}
        <span className={styles.count}>({todos.length})</span>
      </div>
      {hasTruncatedSubagentTree && (
        <div className={styles.lineageNotice} role="status">
          {t('planExecution.lineageTruncated')}
        </div>
      )}
      <div
        className={hasDependencies ? styles.dagViewport : styles.flatList}
        {...(hasDependencies ? { 'data-plan-workflow': true } : {})}
      >
        <div
          className={hasDependencies ? styles.dagCanvas : styles.flatCanvas}
          ref={hasDependencies ? graphRef : undefined}
        >
          {drawsDependencyEdges && graph.edges.length > 0 && (
            <svg
              className={styles.dagEdges}
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
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path
                    className={styles.edgeArrow}
                    d="M 0 0 L 7 3.5 L 0 7 z"
                  />
                </marker>
              </defs>
              {graph.edges.map((edge) => (
                <path
                  className={styles.dagEdge}
                  data-plan-edge
                  data-from={edge.from}
                  data-to={edge.to}
                  d={edge.d}
                  key={JSON.stringify([edge.from, edge.to])}
                  markerEnd={`url(#${markerId})`}
                />
              ))}
            </svg>
          )}
          {layers.map((layer, index) => (
            <div className={styles.layer} key={index}>
              {layer.map((todo) => {
                const executions = toolsByTodo.get(todo.id) ?? [];
                const state = getPlanNodeState(
                  todo,
                  todosById,
                  executions,
                  tasks,
                );
                return (
                  <article
                    className={styles.node}
                    data-status={state.status}
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
                      aria-expanded={selectedTodoId === todo.id}
                      aria-controls={
                        selectedTodoId === todo.id ? detailsId : undefined
                      }
                      title={`${t(
                        selectedTodoId === todo.id
                          ? 'todo.detail.hide'
                          : 'todo.detail.show',
                      )}: ${todo.content}`}
                      onClick={() =>
                        setSelectedTodoId((current) =>
                          current === todo.id ? undefined : todo.id,
                        )
                      }
                    >
                      <div className={styles.nodeTop}>
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
                        {executions.map(renderExecution)}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {selectedTodo && selectedState && (
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
          {selectedExecutions.length > 0 && (
            <div className={styles.stepExecutions}>
              <div className={styles.stepExecutionsTitle}>
                {t('planExecution.subagents')}
              </div>
              <div className={styles.executions}>
                {selectedExecutions.map(renderExecution)}
              </div>
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
            {unassigned.map(renderExecution)}
          </div>
        </div>
      )}
    </section>
  );
}

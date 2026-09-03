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
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
import { useI18n } from '../../i18n';
import { formatRuntime } from '../../utils/formatRuntime';
import {
  getAgentDescription,
  getAgentDisplayStatus,
  isAgentCancelled,
  sanitizeControlChars,
} from './toolFormatting';
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

interface TaskExecutionIndex {
  rootByToolCallId: ReadonlyMap<string, DaemonSessionAgentTaskStatus>;
  childrenByParentId: ReadonlyMap<string, DaemonSessionAgentTaskStatus[]>;
  nestedByRootId: Map<
    string,
    Array<{ task: DaemonSessionAgentTaskStatus; depth: number }>
  >;
}

function createTaskExecutionIndex(
  tasks: readonly DaemonSessionTaskStatus[],
): TaskExecutionIndex {
  const rootByToolCallId = new Map<string, DaemonSessionAgentTaskStatus>();
  const childrenByParentId = new Map<string, DaemonSessionAgentTaskStatus[]>();
  for (const task of tasks) {
    if (task.kind !== 'agent') continue;
    if (task.parentAgentId == null) {
      if (!task.toolUseId || rootByToolCallId.has(task.toolUseId)) continue;
      rootByToolCallId.set(task.toolUseId, task);
      continue;
    }
    const siblings = childrenByParentId.get(task.parentAgentId) ?? [];
    siblings.push(task);
    childrenByParentId.set(task.parentAgentId, siblings);
  }
  return {
    rootByToolCallId,
    childrenByParentId,
    nestedByRootId: new Map(),
  };
}

function taskForTool(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
): DaemonSessionAgentTaskStatus | undefined {
  return taskIndex.rootByToolCallId.get(tool.callId);
}

function executionStatus(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
): string {
  const liveStatus = taskForTool(tool, taskIndex)?.status;
  if (liveStatus) return liveStatus;
  const persistedStatus =
    tool.rawOutput && typeof tool.rawOutput === 'object'
      ? (tool.rawOutput as Record<string, unknown>)['status']
      : undefined;
  if (persistedStatus === 'paused') return persistedStatus;
  return isAgentCancelled(tool) ? 'cancelled' : getAgentDisplayStatus(tool);
}

/**
 * Whether an executionStatus counts toward the overview strip's "Active
 * agents". Deliberately the same statuses that make
 * `getPlanNodeStateFromIndex` render a node running/paused: the live task
 * statuses ('running' / 'paused') plus the transcript 'in_progress' that
 * `executionStatus` reports for an in-flight tool call with no live daemon
 * task — so the strip and the node badges never contradict each other.
 */
function isAgentExecutionActive(status: string): boolean {
  return (
    status === 'running' || status === 'in_progress' || status === 'paused'
  );
}

function nestedTasksFromIndex(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
): Array<{ task: DaemonSessionAgentTaskStatus; depth: number }> {
  const root = taskForTool(tool, taskIndex);
  if (!root) return [];
  const cached = taskIndex.nestedByRootId.get(root.id);
  if (cached) return cached;

  const nested: Array<{
    task: DaemonSessionAgentTaskStatus;
    depth: number;
  }> = [];
  const visited = new Set([root.id]);
  const stack = (taskIndex.childrenByParentId.get(root.id) ?? [])
    .slice()
    .reverse()
    .map((task) => ({ task, depth: 1 }));
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (visited.has(entry.task.id)) continue;
    visited.add(entry.task.id);
    nested.push(entry);
    const descendants = taskIndex.childrenByParentId.get(entry.task.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      stack.push({ task: descendants[index], depth: entry.depth + 1 });
    }
  }
  taskIndex.nestedByRootId.set(root.id, nested);
  return nested;
}

export function nestedTasksForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): Array<{ task: DaemonSessionAgentTaskStatus; depth: number }> {
  return nestedTasksFromIndex(tool, createTaskExecutionIndex(tasks));
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

/**
 * The execution status observed for every agent under one tool: the tool's
 * own execution, every nested live task, and every nested transcript agent.
 * An agent observed through BOTH a live task and a persisted transcript tool
 * (a nested task whose toolUseId matches the nested tool's callId) counts
 * once, keeping the actionable observation: getAttentionAgentTool opens the
 * failed/cancelled surface when either reports one, so the tally must agree
 * with the affordance. getPlanNodeStateFromIndex decides attention on
 * exactly these statuses and the cockpit's attention stats tally them, so
 * the triage strip and the queue can never contradict each other.
 */
function attentionAgentStatuses(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
): string[] {
  const byAgent = new Map<string, string>();
  const record = (agentKey: string, status: string) => {
    const existing = byAgent.get(agentKey);
    if (
      existing === undefined ||
      (existing !== 'failed' &&
        existing !== 'cancelled' &&
        (status === 'failed' || status === 'cancelled'))
    ) {
      byAgent.set(agentKey, status);
    }
  };
  const root = taskForTool(tool, taskIndex);
  record(
    root ? `task:${root.id}` : `tool:${tool.callId}`,
    executionStatus(tool, taskIndex),
  );
  const liveTaskIdByToolCallId = new Map<string, string>();
  for (const { task } of nestedTasksFromIndex(tool, taskIndex)) {
    record(`task:${task.id}`, task.status);
    if (task.toolUseId) liveTaskIdByToolCallId.set(task.toolUseId, task.id);
  }
  for (const { tool: nestedTool } of nestedAgentToolsForTool(tool)) {
    const liveTaskId = liveTaskIdByToolCallId.get(nestedTool.callId);
    record(
      liveTaskId ? `task:${liveTaskId}` : `tool:${nestedTool.callId}`,
      executionStatus(nestedTool, taskIndex),
    );
  }
  return [...byAgent.values()];
}

/**
 * Same agent-status walk as {@link attentionAgentStatuses}, for callers that
 * hold the raw task list instead of a prebuilt index (the cockpit's stats
 * strip, which must tally exactly what the attention queue shows).
 */
export function getAttentionAgentStatuses(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): string[] {
  return attentionAgentStatuses(tool, createTaskExecutionIndex(tasks));
}

function transcriptAgentTask(
  tool: ACPToolCall,
  status: string,
  depth?: number,
): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: `tool:${tool.callId}`,
    label: tool.title || String(tool.args?.description ?? 'Agent'),
    description:
      typeof tool.args?.description === 'string' ? tool.args.description : '',
    status: status === 'paused' ? 'paused' : 'running',
    startTime: 0,
    runtimeMs: 0,
    isBackgrounded: false,
    toolUseId: tool.callId,
    ...(depth === undefined ? {} : { depth }),
  };
}

function activeAgentEntry(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
  depth?: number,
): DaemonSessionAgentTaskStatus | undefined {
  const status = executionStatus(tool, taskIndex);
  if (!isAgentExecutionActive(status)) return undefined;
  const liveTask = taskForTool(tool, taskIndex);
  if (liveTask) return liveTask;
  return transcriptAgentTask(tool, status, depth);
}

/**
 * One entry per agent the overview strip reports as active, and the single
 * source the workflow inspector summary counts: the live daemon task when
 * one exists, otherwise a transcript-derived stand-in for an in-flight tool
 * call with no live task (the replay shape). The walk mirrors the node
 * badges (executionStatus), so the strip, the badges, and the inspector can
 * never contradict each other. An agent observed through BOTH a live task
 * and a persisted transcript tool counts once (dedup by toolUseId).
 */
export function getActiveAgents(
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): DaemonSessionAgentTaskStatus[] {
  const taskIndex = createTaskExecutionIndex(tasks);
  const active: DaemonSessionAgentTaskStatus[] = [];
  for (const tool of tools) {
    const root = activeAgentEntry(tool, taskIndex);
    if (root) active.push(root);
    const nestedLiveTasks = nestedTasksFromIndex(tool, taskIndex);
    for (const { task } of nestedLiveTasks) {
      if (task.status === 'running' || task.status === 'paused') {
        active.push(task);
      }
    }
    const liveNestedToolUseIds = new Set(
      nestedLiveTasks
        .map(({ task }) => task.toolUseId)
        .filter((toolUseId): toolUseId is string => toolUseId !== undefined),
    );
    for (const { tool: nestedTool, depth } of nestedAgentToolsForTool(tool)) {
      if (liveNestedToolUseIds.has(nestedTool.callId)) continue;
      const nested = activeAgentEntry(nestedTool, taskIndex, depth);
      if (nested) active.push(nested);
    }
  }
  return active;
}

function getPlanNodeStateFromIndex(
  todo: TodoItem,
  todosById: ReadonlyMap<string, TodoItem>,
  tools: readonly ACPToolCall[],
  taskIndex: TaskExecutionIndex,
): { status: PlanNodeStatus; attention: boolean } {
  const executionStatuses = tools.map((tool) =>
    executionStatus(tool, taskIndex),
  );
  const attention = tools.some((tool) =>
    attentionAgentStatuses(tool, taskIndex).some(
      (status) => status === 'failed' || status === 'cancelled',
    ),
  );
  if (
    executionStatuses.includes('running') ||
    executionStatuses.includes('in_progress')
  )
    return { status: 'running', attention };
  if (executionStatuses.includes('paused'))
    return { status: 'paused', attention };
  if (todo.status === 'completed')
    return { status: 'completed', attention: false };
  const blocked = (todo.blockedBy ?? []).some(
    (id) => todosById.has(id) && todosById.get(id)?.status !== 'completed',
  );
  if (blocked) return { status: 'blocked', attention };
  if (todo.status === 'in_progress')
    return { status: 'in_progress', attention };
  return { status: 'ready', attention };
}

export function getPlanNodeState(
  todo: TodoItem,
  todosById: ReadonlyMap<string, TodoItem>,
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): { status: PlanNodeStatus; attention: boolean } {
  return getPlanNodeStateFromIndex(
    todo,
    todosById,
    tools,
    createTaskExecutionIndex(tasks),
  );
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

export function getAttentionAgentTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): ACPToolCall | undefined {
  const taskIndex = createTaskExecutionIndex(tasks);
  const nestedTools = nestedAgentToolsForTool(tool);
  const nestedToolByCallId = new Map(
    nestedTools.map(({ tool: nestedTool }) => [nestedTool.callId, nestedTool]),
  );
  const failedTask = [...nestedTasksFromIndex(tool, taskIndex)]
    .reverse()
    .find(
      ({ task }) => task.status === 'failed' || task.status === 'cancelled',
    )?.task;
  if (failedTask?.toolUseId) {
    return (
      nestedToolByCallId.get(failedTask.toolUseId) ??
      toolForNestedTask(failedTask)
    );
  }
  const failedTool = [...nestedTools].reverse().find(({ tool: nestedTool }) => {
    const status = executionStatus(nestedTool, taskIndex);
    return status === 'failed' || status === 'cancelled';
  })?.tool;
  if (failedTool) return failedTool;
  const status = executionStatus(tool, taskIndex);
  return status === 'failed' || status === 'cancelled' ? tool : undefined;
}

export function PlanExecutionView({
  todos,
  tools,
  tasks,
  onOpenSubagent,
  hideTitle = false,
  selection,
  showStepDetails = true,
}: {
  todos: readonly TodoItem[];
  tools: readonly ACPToolCall[];
  tasks: readonly DaemonSessionTaskStatus[];
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
  const taskIndex = useMemo(() => createTaskExecutionIndex(tasks), [tasks]);

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
  const statesByTodo = new Map(
    todos.map((todo) => [
      todo.id,
      getPlanNodeStateFromIndex(
        todo,
        todosById,
        toolsByTodo.get(todo.id) ?? [],
        taskIndex,
      ),
    ]),
  );
  const completedCount = todos.filter(
    (todo) => todo.status === 'completed',
  ).length;
  // floor, not round: (N-1)/N rounds up to 100% on long plans, reporting
  // completion (including to aria-valuenow) while a step is still outstanding.
  const progressPercent =
    todos.length === 0 ? 0 : Math.floor((completedCount / todos.length) * 100);
  // Derive from the same source as the node badges (executionStatus): the
  // live daemon index when a task exists, otherwise the tool call's
  // persisted/transcript status. Counting only live tasks contradicted the
  // badges on a replayed transcript of an interrupted session — the node
  // rendered Running off an in_progress tool call while this strip reported
  // "Active agents: 0" because no live daemon task existed. The workflow
  // inspector summary counts the very same helper output, so the two
  // surfaces can never contradict each other.
  const activeAgentCount = useMemo(
    () => getActiveAgents(tools, tasks).length,
    [tools, tasks],
  );
  const attentionCount = [...statesByTodo.values()].filter(
    (state) => state.attention,
  ).length;
  const topology = todos.map((todo): [string, string[]] => [
    todo.id,
    [...new Set(todo.blockedBy ?? [])].filter(
      (dependencyId) => dependencyId !== todo.id && knownIds.has(dependencyId),
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
  for (const [todoId, dependencies] of topology) {
    for (const dependencyId of dependencies) {
      const dependents = dependentsByTodo.get(dependencyId) ?? [];
      dependents.push(todoId);
      dependentsByTodo.set(dependencyId, dependents);
    }
  }
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
                    key={JSON.stringify([edge.from, edge.to])}
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

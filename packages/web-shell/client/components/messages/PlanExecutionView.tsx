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
import { useTranscriptRenderMode } from '../../transcriptRenderMode';
import { formatRuntime } from '../../utils/formatRuntime';
import {
  getAgentDescription,
  getSubagentDetailsUnavailableReason,
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

  lanes: number;
}

const EMPTY_GRAPH_LAYOUT: PlanGraphLayout = {
  width: 1,
  height: 1,
  edges: [],
  lanes: 0,
};

const EDGE_LANE_HEIGHT = 9;

const EDGE_CORNER = 6;

const MAX_RENDERED_PLAN_EDGES = 500;

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
        (depId) => depId !== todo.id && byId.has(depId),
      ),
    );
    indegrees.set(todo.id, dependencies.size);
    depths.set(todo.id, 0);
    for (const depId of dependencies) {
      const children = dependents.get(depId) ?? [];
      children.push(todo.id);
      dependents.set(depId, children);
    }
  }

  const queue = [...byId.keys()].filter((id) => indegrees.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const nextDepth = (depths.get(id) ?? 0) + 1;
    for (const depId of dependents.get(id) ?? []) {
      depths.set(depId, Math.max(depths.get(depId) ?? 0, nextDepth));
      const remaining = (indegrees.get(depId) ?? 1) - 1;
      indegrees.set(depId, remaining);
      if (remaining === 0) queue.push(depId);
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

export interface TaskExecutionIndex {
  rootByToolCallId: ReadonlyMap<string, DaemonSessionAgentTaskStatus>;
  childrenByParentId: ReadonlyMap<string, DaemonSessionAgentTaskStatus[]>;
  nestedByRootId: Map<
    string,
    Array<{ task: DaemonSessionAgentTaskStatus; depth: number }>
  >;
}

export function createTaskExecutionIndex(
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

function isAgentExecutionActive(status: string): boolean {
  return (
    status === 'running' || status === 'in_progress' || status === 'paused'
  );
}

export function nestedTasksFromIndex(
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
    for (let i = descendants.length - 1; i >= 0; i--) {
      stack.push({ task: descendants[i], depth: entry.depth + 1 });
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

export function getActiveAgents(
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): DaemonSessionAgentTaskStatus[] {
  return getActiveAgentsFromIndex(tools, createTaskExecutionIndex(tasks));
}

export function getActiveAgentsFromIndex(
  tools: readonly ACPToolCall[],
  taskIndex: TaskExecutionIndex,
): DaemonSessionAgentTaskStatus[] {
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
        .filter((id): id is string => id !== undefined),
    );
    for (const { tool: nestedTool, depth } of nestedAgentToolsForTool(tool)) {
      if (liveNestedToolUseIds.has(nestedTool.callId)) continue;
      const nested = activeAgentEntry(nestedTool, taskIndex, depth);
      if (nested) active.push(nested);
    }
  }
  return active;
}

export function getPlanNodeStateFromIndex(
  todo: TodoItem,
  todosById: ReadonlyMap<string, TodoItem>,
  tools: readonly ACPToolCall[],
  taskIndex: TaskExecutionIndex,
): { status: PlanNodeStatus; attention: boolean } {
  const execStatuses = tools.map((tool) => executionStatus(tool, taskIndex));
  const attention = tools.some((tool) =>
    attentionAgentStatuses(tool, taskIndex).some(
      (s) => s === 'failed' || s === 'cancelled',
    ),
  );
  if (execStatuses.includes('running') || execStatuses.includes('in_progress'))
    return { status: 'running', attention };
  if (execStatuses.includes('paused')) return { status: 'paused', attention };
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

export function todoIdOf(tool: ACPToolCall): string | undefined {
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
    nestedTools.map(({ tool: nt }) => [nt.callId, nt]),
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
  const failedTool = [...nestedTools].reverse().find(({ tool: nt }) => {
    const s = executionStatus(nt, taskIndex);
    return s === 'failed' || s === 'cancelled';
  })?.tool;
  if (failedTool) return failedTool;
  const s = executionStatus(tool, taskIndex);
  return s === 'failed' || s === 'cancelled' ? tool : undefined;
}

export interface PlanExecutionViewProps {
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

  showStepDetails?: boolean;
  forceFlatLayout?: boolean;
}

export function PlanExecutionView({
  todos,
  tools,
  tasks,
  onOpenSubagent,
  hideTitle = false,
  selection,
  showStepDetails = true,
  forceFlatLayout = false,
}: PlanExecutionViewProps): React.JSX.Element | null {
  const { t } = useI18n();
  const documentMode = useTranscriptRenderMode() === 'document';
  const taskIndex = useMemo(() => createTaskExecutionIndex(tasks), [tasks]);

  const {
    todosById,
    toolsByTodo,
    unassigned,
    statesByTodo,
    completedCount,
    progressPercent,
    activeAgentCount,
    attentionCount,
    topology,
    topologyKey,
    dependencyCount,
    hasDependencies,
    drawsDependencyEdges,
    layers,
    layerByTodo,
    dependentsByTodo,
  } = useMemo(() => {
    const knownIds = new Set(todos.map((todo) => todo.id));
    const todosByIdLocal = new Map(todos.map((todo) => [todo.id, todo]));
    const toolsByTodoLocal = new Map<string, ACPToolCall[]>();
    const unassignedLocal: ACPToolCall[] = [];
    for (const tool of tools) {
      const tid = todoIdOf(tool);
      if (!tid || !knownIds.has(tid)) {
        unassignedLocal.push(tool);
        continue;
      }
      const grouped = toolsByTodoLocal.get(tid) ?? [];
      grouped.push(tool);
      toolsByTodoLocal.set(tid, grouped);
    }
    const statesByTodoLocal = new Map(
      todos.map((todo) => [
        todo.id,
        getPlanNodeStateFromIndex(
          todo,
          todosByIdLocal,
          toolsByTodoLocal.get(todo.id) ?? [],
          taskIndex,
        ),
      ]),
    );
    const completedCountLocal = todos.filter(
      (todo) => todo.status === 'completed',
    ).length;
    const progressPercentLocal =
      todos.length === 0
        ? 0
        : Math.floor((completedCountLocal / todos.length) * 100);
    const activeAgentCountLocal = getActiveAgentsFromIndex(
      tools,
      taskIndex,
    ).length;
    const attentionCountLocal = [...statesByTodoLocal.values()].filter(
      (state) => state.attention,
    ).length;
    const topologyLocal = todos.map((todo): [string, string[]] => [
      todo.id,
      [...new Set(todo.blockedBy ?? [])].filter(
        (depId) => depId !== todo.id && knownIds.has(depId),
      ),
    ]);

    const topologyKeyLocal = JSON.stringify(topologyLocal);
    const dependencyCountLocal = topologyLocal.reduce(
      (total, entry) => total + entry[1].length,
      0,
    );
    const hasDependenciesLocal = dependencyCountLocal > 0;
    const drawsDependencyEdgesLocal =
      hasDependenciesLocal && dependencyCountLocal <= MAX_RENDERED_PLAN_EDGES;
    const layersLocal = hasDependenciesLocal
      ? layerPlanTodos(todos)
      : [todos.slice()];
    const layerByTodoLocal = new Map<string, number>();
    const dependentsByTodoLocal = new Map<string, string[]>();
    layersLocal.forEach((layer, index) => {
      for (const todo of layer) layerByTodoLocal.set(todo.id, index);
    });
    for (const [todoId, deps] of topologyLocal) {
      for (const depId of deps) {
        const depsList = dependentsByTodoLocal.get(depId) ?? [];
        depsList.push(todoId);
        dependentsByTodoLocal.set(depId, depsList);
      }
    }
    return {
      todosById: todosByIdLocal,
      toolsByTodo: toolsByTodoLocal,
      unassigned: unassignedLocal,
      statesByTodo: statesByTodoLocal,
      completedCount: completedCountLocal,
      progressPercent: progressPercentLocal,
      activeAgentCount: activeAgentCountLocal,
      attentionCount: attentionCountLocal,
      topology: topologyLocal,
      topologyKey: topologyKeyLocal,
      dependencyCount: dependencyCountLocal,
      hasDependencies: hasDependenciesLocal,
      drawsDependencyEdges: drawsDependencyEdgesLocal,
      layers: layersLocal,
      layerByTodo: layerByTodoLocal,
      dependentsByTodo: dependentsByTodoLocal,
    };
  }, [taskIndex, todos, tools]);
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
  const focusedTodoId = hoveredTodoId ?? selectedTodoId;

  const todoIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    todos.forEach((todo, index) => map.set(todo.id, index));
    return map;
  }, [todos]);

  const focusTodoId =
    todos.find((todo) => {
      const status = statesByTodo.get(todo.id)?.status;
      return status === 'running' || status === 'in_progress';
    })?.id ??
    todos.find((todo) => todo.status !== 'completed')?.id ??
    todos[0]?.id;

  const handleOpenSubagent = useCallback(
    (tool: ACPToolCall) => {
      if (!getSubagentDetailsUnavailableReason(tool)) onOpenSubagent?.(tool);
    },
    [onOpenSubagent],
  );

  const handleSelectTodo = useCallback(
    (todoId: string | undefined) => {
      updateSelectedTodoId(todoId);
    },
    [updateSelectedTodoId],
  );

  const [activeUpIdx, setActiveUpIdx] = useState(0);
  const [activeDownIdx, setActiveDownIdx] = useState(0);
  useEffect(() => {
    setActiveUpIdx(0);
    setActiveDownIdx(0);
  }, [selectedTodoId]);

  const handleGraphKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selectedTodoId) return;
      const todo = todosById.get(selectedTodoId);
      if (!todo) return;

      let nextId: string | undefined;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        const blockedByIds = (todo.blockedBy ?? []).filter((id) =>
          todosById.has(id),
        );
        if (blockedByIds.length > 0) {
          nextId = blockedByIds[activeUpIdx % blockedByIds.length];
          setActiveUpIdx((prev) => (prev + 1) % blockedByIds.length);
        }
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        const dependents = dependentsByTodo.get(selectedTodoId) ?? [];
        if (dependents.length > 0) {
          nextId = dependents[activeDownIdx % dependents.length];
          setActiveDownIdx((prev) => (prev + 1) % dependents.length);
        }
      }

      if (nextId) {
        e.preventDefault();
        updateSelectedTodoId(nextId);
      }
    },
    [
      selectedTodoId,
      todosById,
      dependentsByTodo,
      activeUpIdx,
      activeDownIdx,
      updateSelectedTodoId,
    ],
  );

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
      const top =
        viewport.scrollTop +
        nodeRect.top -
        viewportRect.top -
        (viewport.clientHeight - nodeRect.height) / 2;
      try {
        if (typeof viewport.scrollTo === 'function') {
          viewport.scrollTo({ left, top, behavior });
        } else {
          viewport.scrollLeft = left;
          viewport.scrollTop = top;
        }
      } catch {
        viewport.scrollLeft = left;
        viewport.scrollTop = top;
      }
    },
    [focusTodoId],
  );

  const handleLocateClick = useCallback(() => {
    locateFocusTodo('smooth');
  }, [locateFocusTodo]);

  const renderDependencyLinks = useCallback(
    (ids: readonly string[], emptyLabel: string) => {
      const validIds = ids.filter((id) => todosById.has(id));
      if (validIds.length === 0) return <>{emptyLabel}</>;
      return (
        <>
          {validIds.map((id, i) => {
            const todo = todosById.get(id);
            if (!todo) return null;
            const stepNum = todoIndexMap.get(id);
            const label =
              stepNum != null
                ? `${stepNum + 1}. ${todo.content}`
                : todo.content;
            return (
              <span key={id} className={styles.dependencyLinkWrapper}>
                {i > 0 && (
                  <span className={styles.dependencySeparator}>, </span>
                )}
                <span
                  className={styles.dependencyLink}
                  role="link"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelectTodo(id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSelectTodo(id);
                    }
                  }}
                  aria-label={t('planExecution.navigateToStep', { label })}
                >
                  {label}
                </span>
              </span>
            );
          })}
        </>
      );
    },
    [todosById, todoIndexMap, handleSelectTodo, t],
  );

  useEffect(() => {
    if (selectedTodoId && !todos.some((todo) => todo.id === selectedTodoId)) {
      updateSelectedTodoId(undefined);
    }
  }, [selectedTodoId, todos, updateSelectedTodoId]);

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
    )
      return;
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
      for (const [todoId, deps] of topologyRef.current) {
        const targetRect = measuredNodes.get(todoId);
        if (!targetRect) continue;
        for (const depId of deps) {
          const sourceRect = measuredNodes.get(depId);
          if (!sourceRect) continue;
          const startX = sourceRect.right + 4;
          const startY = sourceRect.top + sourceRect.height / 2;
          const endX = targetRect.left - 4;
          const endY = targetRect.top + targetRect.height / 2;
          const span =
            (layerByTodoRef.current.get(todoId) ?? 0) -
            (layerByTodoRef.current.get(depId) ?? 0);
          if (span > 1) {
            spanning.push({
              from: depId,
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
            from: depId,
            to: todoId,
            d: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
          });
        }
      }
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
      const signature = `${next.width}:${next.height}:${next.lanes}:${edges.map((e) => `${e.from}>${e.to}>${e.d}`).join('|')}`;
      if (signature === graphSignatureRef.current) return;
      graphSignatureRef.current = signature;
      setGraph(next);
    };

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
      transcriptNestedTools.map(({ tool: nt }) => [nt.callId, nt]),
    );
    const liveNestedCallIds = new Set(
      nestedTasks.flatMap(({ task }) =>
        task.toolUseId ? [task.toolUseId] : [],
      ),
    );
    const nestedTools = transcriptNestedTools.filter(
      ({ tool: nt }) => !liveNestedCallIds.has(nt.callId),
    );

    return (
      <div className={styles.executionGroup} key={tool.callId}>
        <button
          type="button"
          className={`${styles.execution}${expanded ? ` ${styles.executionExpanded}` : ''}`}
          data-plan-interactive
          onClick={() => handleOpenSubagent(tool)}
          disabled={!onOpenSubagent}
          aria-disabled={
            !!getSubagentDetailsUnavailableReason(tool) || undefined
          }
          title={t(
            getSubagentDetailsUnavailableReason(tool) ??
              'planExecution.openDetails',
          )}
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
              onClick={() => handleOpenSubagent(nestedTool)}
              disabled={!onOpenSubagent}
              aria-disabled={
                !!getSubagentDetailsUnavailableReason(nestedTool) || undefined
              }
              title={t(
                getSubagentDetailsUnavailableReason(nestedTool) ??
                  'planExecution.openDetails',
              )}
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
        {nestedTools.map(({ tool: nt, depth }) => (
          <button
            type="button"
            className={styles.nestedExecution}
            data-plan-interactive
            key={nt.callId}
            style={{ paddingLeft: `${Math.min(depth, 3) * 12}px` }}
            onClick={() => handleOpenSubagent(nt)}
            disabled={!onOpenSubagent}
            aria-disabled={
              !!getSubagentDetailsUnavailableReason(nt) || undefined
            }
            title={t(
              getSubagentDetailsUnavailableReason(nt) ??
                'planExecution.openDetails',
            )}
          >
            <span className={styles.executionLabel}>
              ↳ {nt.title || String(nt.args?.description ?? nt.toolName)}
            </span>
            <span className={styles.executionStatus}>
              {t(executionStatusKey(executionStatus(nt, taskIndex)))}
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <section className={styles.section} aria-label={t('planExecution.title')}>
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
              onClick={handleLocateClick}
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

      {!forceFlatLayout && hasDependencies && !drawsDependencyEdges && (
        <p className={styles.edgeNotice} role="status">
          {t('planExecution.edgesHidden', { count: dependencyCount })}
        </p>
      )}

      <div
        className={
          forceFlatLayout || !hasDependencies
            ? styles.flatList
            : styles.dagViewport
        }
        ref={!forceFlatLayout && hasDependencies ? viewportRef : undefined}
        onKeyDown={handleGraphKeyDown}
        tabIndex={0}
        {...(!forceFlatLayout && hasDependencies
          ? { 'data-plan-workflow': true }
          : {})}
      >
        <div
          className={
            forceFlatLayout || !hasDependencies
              ? styles.flatCanvas
              : styles.dagCanvas
          }
          ref={!forceFlatLayout && hasDependencies ? graphRef : undefined}
          style={
            !forceFlatLayout && hasDependencies
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
                const isSelected = selectedTodoId === todo.id;
                const blockedByIds = todo.blockedBy ?? [];

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
                    onFocus={() => setHoveredTodoId(todo.id)}
                    onBlur={() =>
                      setHoveredTodoId((current) =>
                        current === todo.id ? undefined : current,
                      )
                    }
                    data-plan-input={
                      (drawsDependencyEdges && blockedByIds.length > 0) ||
                      undefined
                    }
                    data-plan-output={
                      (drawsDependencyEdges &&
                        (dependentsByTodo.get(todo.id)?.length ?? 0) > 0) ||
                      undefined
                    }
                    data-selected={isSelected || undefined}
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
                      aria-pressed={isSelected}
                      aria-expanded={showStepDetails ? isSelected : undefined}
                      aria-controls={
                        showStepDetails && isSelected ? detailsId : undefined
                      }
                      title={`${t(
                        showStepDetails && isSelected
                          ? 'todo.detail.hide'
                          : 'todo.detail.show',
                      )}: ${todo.content}`}
                      onClick={() =>
                        handleSelectTodo(
                          showStepDetails && isSelected ? undefined : todo.id,
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
                      {blockedByIds.length > 0 && (
                        <div className={styles.dependencies}>
                          {t('planExecution.dependsOn')}{' '}
                          {renderDependencyLinks(
                            blockedByIds,
                            t('workflow.dependencies.none'),
                          )}
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

      {/* Inline Step Details Panel */}
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
              {renderDependencyLinks(
                selectedTodo.blockedBy!,
                t('workflow.dependencies.none'),
              )}
            </div>
          )}
          {selectedDependents.length > 0 && (
            <div className={styles.dependencies}>
              {t('planExecution.unblocks')}{' '}
              {renderDependencyLinks(
                selectedDependents,
                t('workflow.dependencies.noDownstream'),
              )}
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

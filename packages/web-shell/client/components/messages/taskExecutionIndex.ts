import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
import { getAgentDisplayStatus, isAgentCancelled } from './toolFormatting';

/**
 * Shared task-execution lookups for the plan surfaces. Extracted from
 * `PlanExecutionView` so the workflow projection (`session-workflow-model`)
 * and the graph (`PlanExecutionView`) both depend on this module instead of
 * on each other, and so one build of the index can be threaded from the
 * projection into every consumer in a single render.
 */
export type PlanNodeStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'in_progress'
  | 'ready';

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

export function taskForTool(
  tool: ACPToolCall,
  taskIndex: TaskExecutionIndex,
): DaemonSessionAgentTaskStatus | undefined {
  return taskIndex.rootByToolCallId.get(tool.callId);
}

export function executionStatus(
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

/**
 * Deliberately uncached. Keying on the tool object would be wrong the moment
 * a reused object gains a sub-tool — `appendSubTool` mutates `subTools` in
 * place — and the only thing standing between that and a stale render is
 * `useMessages`' prefix-reuse rule in another module. The callers' own
 * derivations are memoized, so the repetition this would remove is bounded to
 * a single derivation; a silent wrong subtree is not worth that.
 */
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
  return getActiveAgentsFromIndex(tools, createTaskExecutionIndex(tasks));
}

/**
 * {@link getActiveAgents} for callers that already hold an index. Building the
 * index is O(tasks); doing it per todo and per tool — as the workflow
 * projection used to — makes the walk O((todos + tools) x tasks) for a result
 * that never varies with the todo or the tool.
 */
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

export function getPlanNodeStateFromIndex(
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

/** The plan step a tool call was issued for, when it declares one. */
export function todoIdOf(tool: ACPToolCall): string | undefined {
  const value = tool.args?.todo_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A clickable stand-in for a live agent task that has no transcript tool
 * call, so the graph's nested execution rows can still open its panel.
 */
export function toolForNestedTask(
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
  if (status === 'failed' || status === 'cancelled') return tool;
  return undefined;
}

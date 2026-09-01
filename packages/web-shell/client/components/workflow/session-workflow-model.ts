import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { isSubAgentToolCall } from '../../adapters/toolClassification';
import {
  getActiveAgents,
  getPlanNodeState,
  nestedTasksForTool,
  type PlanNodeStatus,
} from '../messages/PlanExecutionView';

export interface SessionWorkflowProjection {
  todosById: ReadonlyMap<string, TodoItem>;
  toolsByTaskId: ReadonlyMap<string, ACPToolCall>;
  toolsByTodo: ReadonlyMap<string, readonly ACPToolCall[]>;
  agentToolsByTodo: ReadonlyMap<string, readonly ACPToolCall[]>;
  tasksByTool: ReadonlyMap<ACPToolCall, DaemonSessionAgentTaskStatus>;
  states: ReadonlyMap<string, { status: PlanNodeStatus; attention: boolean }>;
  attentionTodos: readonly TodoItem[];
  activeAgents: readonly DaemonSessionAgentTaskStatus[];
  activity: readonly DaemonSessionAgentTaskStatus[];
  completedCount: number;
  progressPercent: number;
  taskStatusI18nKey:
    | 'workflow.task.attention'
    | 'workflow.task.running'
    | 'workflow.task.completed'
    | 'workflow.task.waitingExecution';
  taskStatusTone: 'attention' | 'running' | 'completed' | 'waiting';
}

export function workflowTodoId(tool: ACPToolCall): string | undefined {
  const value = tool.args?.todo_id;
  return typeof value === 'string' && value ? value : undefined;
}

function taskForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
  parentAgentId: string | undefined,
): DaemonSessionAgentTaskStatus | undefined {
  return tasks.find(
    (task): task is DaemonSessionAgentTaskStatus =>
      task.kind === 'agent' &&
      task.toolUseId === tool.callId &&
      (task.parentAgentId ?? undefined) === parentAgentId,
  );
}

function flattenTools(tools: readonly ACPToolCall[]): ACPToolCall[] {
  const result: ACPToolCall[] = [];
  const visit = (tool: ACPToolCall) => {
    result.push(tool);
    for (const child of tool.subTools ?? []) visit(child);
  };
  for (const tool of tools) visit(tool);
  return result;
}

function linkedAgentTasks(
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): DaemonSessionAgentTaskStatus[] {
  const linked = new Map<string, DaemonSessionAgentTaskStatus>();
  for (const tool of tools) {
    const root = taskForTool(tool, tasks, undefined);
    if (root) linked.set(root.id, root);
    for (const { task } of nestedTasksForTool(tool, tasks)) {
      linked.set(task.id, task);
    }
  }
  return [...linked.values()];
}

function linkAgentTools(
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): {
  toolsByTaskId: Map<string, ACPToolCall>;
  tasksByTool: Map<ACPToolCall, DaemonSessionAgentTaskStatus>;
} {
  const toolsByTaskId = new Map<string, ACPToolCall>();
  const tasksByTool = new Map<ACPToolCall, DaemonSessionAgentTaskStatus>();
  const visit = (tool: ACPToolCall, parentAgentId: string | undefined) => {
    const task = isSubAgentToolCall(tool)
      ? taskForTool(tool, tasks, parentAgentId)
      : undefined;
    if (task) {
      toolsByTaskId.set(task.id, tool);
      tasksByTool.set(tool, task);
    }
    for (const child of tool.subTools ?? []) {
      visit(child, task?.id ?? parentAgentId);
    }
  };
  for (const tool of tools) visit(tool, undefined);
  return { toolsByTaskId, tasksByTool };
}

export function buildSessionWorkflowProjection(
  todos: readonly TodoItem[],
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): SessionWorkflowProjection {
  const todosById = new Map(todos.map((todo) => [todo.id, todo]));
  const toolsByTodo = new Map<string, ACPToolCall[]>();
  const agentToolsByTodo = new Map<string, ACPToolCall[]>();
  for (const tool of tools) {
    const todoId = workflowTodoId(tool);
    if (!todoId) continue;
    const group = toolsByTodo.get(todoId) ?? [];
    group.push(tool);
    toolsByTodo.set(todoId, group);
    const agentTools = flattenTools([tool]).filter(isSubAgentToolCall);
    if (agentTools.length > 0) {
      agentToolsByTodo.set(todoId, [
        ...(agentToolsByTodo.get(todoId) ?? []),
        ...agentTools,
      ]);
    }
  }
  const states = new Map(
    todos.map((todo) => [
      todo.id,
      getPlanNodeState(todo, todosById, toolsByTodo.get(todo.id) ?? [], tasks),
    ]),
  );
  const { toolsByTaskId, tasksByTool } = linkAgentTools(tools, tasks);
  const linkedAgents = new Map(
    linkedAgentTasks(tools, tasks).map((task) => [task.id, task]),
  );
  for (const task of tasksByTool.values()) linkedAgents.set(task.id, task);
  const agents = [...linkedAgents.values()];
  const attentionTodos = todos.filter((todo) => states.get(todo.id)?.attention);
  // The overview strip's exact tally (live tasks plus the transcript
  // fallback for in-flight tool calls with no live daemon task), so the
  // inspector summary and the strip report the same "Active agents" count
  // for the same session instead of live-only vs fallback divergence.
  const activeAgents = getActiveAgents(tools, tasks);
  const completedCount = todos.filter(
    (todo) => todo.status === 'completed',
  ).length;
  const hasActiveExecution =
    activeAgents.length > 0 ||
    todos.some((todo) => {
      const status = states.get(todo.id)?.status;
      return status === 'running' || status === 'in_progress';
    });
  const taskStatusI18nKey =
    attentionTodos.length > 0
      ? 'workflow.task.attention'
      : hasActiveExecution
        ? 'workflow.task.running'
        : completedCount === todos.length
          ? 'workflow.task.completed'
          : 'workflow.task.waitingExecution';
  const taskStatusTone =
    attentionTodos.length > 0
      ? 'attention'
      : hasActiveExecution
        ? 'running'
        : completedCount === todos.length
          ? 'completed'
          : 'waiting';

  return {
    todosById,
    toolsByTaskId,
    toolsByTodo,
    agentToolsByTodo,
    tasksByTool,
    states,
    attentionTodos,
    activeAgents,
    activity: [...agents].sort((a, b) => b.startTime - a.startTime),
    completedCount,
    progressPercent:
      todos.length === 0
        ? 0
        : Math.floor((completedCount / todos.length) * 100),
    taskStatusI18nKey,
    taskStatusTone,
  };
}

export function getDefaultWorkflowTodoId(
  todos: readonly TodoItem[],
  projection: SessionWorkflowProjection,
): string | undefined {
  return (
    projection.attentionTodos[0]?.id ??
    todos.find((todo) => {
      const status = projection.states.get(todo.id)?.status;
      return status === 'running' || status === 'in_progress';
    })?.id ??
    todos.find((todo) => todo.status !== 'completed')?.id ??
    todos[0]?.id
  );
}

export function workflowTaskStatusKey(
  status: DaemonSessionAgentTaskStatus['status'],
) {
  return `workflow.status.${status}` as const;
}

export function workflowInitials(value: string): string {
  const words = value
    .replace(/[^A-Za-z0-9\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }
  return (
    value
      .replace(/[^A-Za-z\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'AG'
  );
}

export function workflowClock(timestamp?: number): string {
  if (!timestamp) return '--:--';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

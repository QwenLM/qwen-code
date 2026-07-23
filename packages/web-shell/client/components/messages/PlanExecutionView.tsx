import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
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
    (task) => task.kind === 'agent' && task.toolUseId === tool.callId,
  );
}

function executionStatus(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): string {
  const liveStatus = taskForTool(tool, tasks)?.status;
  if (liveStatus) return liveStatus;
  return isAgentCancelled(tool) ? 'cancelled' : getAgentDisplayStatus(tool);
}

export function nestedTasksForTool(
  tool: ACPToolCall,
  tasks: readonly DaemonSessionTaskStatus[],
): Array<{ task: DaemonSessionTaskStatus; depth: number }> {
  const root = taskForTool(tool, tasks);
  if (!root) return [];

  const children = new Map<string, DaemonSessionTaskStatus[]>();
  for (const task of tasks) {
    if (task.kind !== 'agent' || task.parentAgentId == null) continue;
    const siblings = children.get(task.parentAgentId) ?? [];
    siblings.push(task);
    children.set(task.parentAgentId, siblings);
  }

  const result: Array<{ task: DaemonSessionTaskStatus; depth: number }> = [];
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

export function getPlanNodeState(
  todo: TodoItem,
  todosById: ReadonlyMap<string, TodoItem>,
  tools: readonly ACPToolCall[],
  tasks: readonly DaemonSessionTaskStatus[],
): { status: PlanNodeStatus; attention: boolean } {
  const executionStatuses = tools.map((tool) => executionStatus(tool, tasks));
  const attention = executionStatuses.some(
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
  if (todos.length === 0) return null;

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
  const hasDependencies = todos.some(
    (todo) => (todo.blockedBy?.length ?? 0) > 0,
  );
  const layers = hasDependencies ? layerPlanTodos(todos) : [todos.slice()];

  const renderExecution = (tool: ACPToolCall) => {
    const status = executionStatus(tool, tasks);
    const label = tool.title || String(tool.args?.description ?? tool.toolName);
    const nestedTasks = nestedTasksForTool(tool, tasks);
    return (
      <div className={styles.executionGroup} key={tool.callId}>
        <button
          type="button"
          className={styles.execution}
          onClick={() => onOpenSubagent?.(tool)}
          disabled={!onOpenSubagent}
          title={t('planExecution.openDetails')}
        >
          <span className={styles.executionLabel}>{label}</span>
          <span className={styles.executionStatus}>
            {t(executionStatusKey(status))}
          </span>
        </button>
        {nestedTasks.map(({ task, depth }) => (
          <div
            className={styles.nestedExecution}
            key={task.id}
            style={{ paddingLeft: `${Math.min(depth, 3) * 12}px` }}
          >
            <span className={styles.executionLabel}>↳ {task.label}</span>
            <span className={styles.executionStatus}>
              {t(executionStatusKey(task.status))}
            </span>
          </div>
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
      <div className={hasDependencies ? styles.dag : styles.flatList}>
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
                <article className={styles.node} key={todo.id}>
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

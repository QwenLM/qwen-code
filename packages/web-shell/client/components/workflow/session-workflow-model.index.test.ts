// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';

// The projection used to delegate to `getPlanNodeState` (once per todo) and
// `nestedTasksForTool` (once per tool), each of which privately rebuilt the
// task execution index — O((todos + tools) x tasks) for an index that only
// depends on `tasks`. Those private rebuilds are module-internal and so
// invisible to this mock, which is exactly what makes the assertion sharp:
// before the fix the projection built nothing itself and this counter read 0.
// This lives in its own file so the module mock cannot reach the behavioural
// suite next to it.
const indexBuilds = vi.hoisted(() => ({ count: 0 }));

vi.mock('../messages/PlanExecutionView', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../messages/PlanExecutionView')>();
  return {
    ...actual,
    createTaskExecutionIndex: (
      ...args: Parameters<typeof actual.createTaskExecutionIndex>
    ) => {
      indexBuilds.count += 1;
      return actual.createTaskExecutionIndex(...args);
    },
  };
});

const { buildSessionWorkflowProjection } = await import(
  './session-workflow-model'
);

function todo(id: string, blockedBy?: string[]): TodoItem {
  return {
    id,
    content: `Step ${id}`,
    status: 'in_progress',
    ...(blockedBy ? { blockedBy } : {}),
  };
}

function agentTool(callId: string, todoId: string): ACPToolCall {
  return {
    callId,
    toolName: 'Agent',
    title: `Agent ${callId}`,
    status: 'in_progress',
    args: { todo_id: todoId },
  };
}

function liveTask(id: string, toolUseId: string): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id,
    label: id,
    description: '',
    status: 'running',
    startTime: 1,
    runtimeMs: 1,
    isBackgrounded: false,
    toolUseId,
  };
}

describe('buildSessionWorkflowProjection index reuse', () => {
  it('builds the task execution index once regardless of plan size', () => {
    const todos = Array.from({ length: 12 }, (_, index) =>
      todo(`step-${index}`, index === 0 ? undefined : [`step-${index - 1}`]),
    );
    const tools = todos.map((item, index) =>
      agentTool(`call-${index}`, item.id),
    );
    const tasks = tools.map((tool, index) =>
      liveTask(`agent-${index}`, tool.callId),
    ) as readonly DaemonSessionTaskStatus[];

    indexBuilds.count = 0;
    buildSessionWorkflowProjection(todos, tools, tasks);

    expect(indexBuilds.count).toBe(1);
  });
});

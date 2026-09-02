// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import { buildSessionWorkflowProjection } from './session-workflow-model';

const todos: TodoItem[] = [
  { id: 'prepare', content: 'Prepare', status: 'completed' },
  {
    id: 'build',
    content: 'Build',
    status: 'in_progress',
    blockedBy: ['prepare'],
  },
];

function agentTool(callId: string, todoId: string): ACPToolCall {
  return {
    callId,
    toolName: 'Agent',
    title: `Agent ${todoId}`,
    status: 'in_progress',
    args: { todo_id: todoId },
  };
}

function liveTask(
  overrides: Partial<DaemonSessionAgentTaskStatus> = {},
): DaemonSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: 'agent-build',
    label: 'Build agent',
    description: 'Build',
    status: 'running',
    startTime: 1,
    runtimeMs: 1,
    isBackgrounded: false,
    toolUseId: 'call-build',
    ...overrides,
  };
}

describe('buildSessionWorkflowProjection', () => {
  // R11-2: the inspector summary must tally active agents through the same
  // implementation as the overview strip. A transcript-only in_progress
  // Agent tool call with no live daemon task counts 1 on the strip, so the
  // projection must not report 0 for the same input.
  it('counts transcript-only in_progress agents like the overview strip', () => {
    const projection = buildSessionWorkflowProjection(
      todos,
      [agentTool('call-build', 'build')],
      [],
    );

    expect(projection.activeAgents).toHaveLength(1);
    expect(projection.activeAgents[0]).toEqual(
      expect.objectContaining({
        kind: 'agent',
        status: 'running',
        toolUseId: 'call-build',
      }),
    );
  });

  it('keeps live daemon tasks as the active agent entries', () => {
    const task = liveTask();
    const projection = buildSessionWorkflowProjection(
      todos,
      [agentTool('call-build', 'build')],
      [task] as readonly DaemonSessionTaskStatus[],
    );

    // The agent is observed through BOTH a live task and the transcript
    // tool call — it must count once, and the live task wins.
    expect(projection.activeAgents).toEqual([task]);
  });

  it('does not count finished transcript agents', () => {
    const projection = buildSessionWorkflowProjection(
      todos,
      [{ ...agentTool('call-build', 'build'), status: 'completed' }],
      [],
    );

    expect(projection.activeAgents).toHaveLength(0);
  });

  it('keeps nested tool links separate when call IDs collide', () => {
    const childA = agentTool('call-child', 'build');
    const childB = agentTool('call-child', 'build');
    const rootA = { ...agentTool('call-root-a', 'build'), subTools: [childA] };
    const rootB = { ...agentTool('call-root-b', 'build'), subTools: [childB] };
    const taskA = liveTask({
      id: 'child-a',
      toolUseId: 'call-child',
      parentAgentId: 'root-a',
    });
    const taskB = liveTask({
      id: 'child-b',
      toolUseId: 'call-child',
      parentAgentId: 'root-b',
    });
    const projection = buildSessionWorkflowProjection(
      todos,
      [rootA, rootB],
      [
        liveTask({ id: 'root-a', toolUseId: 'call-root-a' }),
        liveTask({ id: 'root-b', toolUseId: 'call-root-b' }),
        taskA,
        taskB,
      ],
    );

    expect(projection.tasksByTool.get(childA)).toBe(taskA);
    expect(projection.tasksByTool.get(childB)).toBe(taskB);
    expect(projection.toolsByTaskId.get('child-a')).toBe(childA);
    expect(projection.toolsByTaskId.get('child-b')).toBe(childB);
  });
});

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionAgentTaskStatus,
  DaemonSessionTaskStatus,
} from '@qwen-code/sdk/daemon';
import type { ACPToolCall, TodoItem } from '../../adapters/types';
import {
  buildSessionWorkflowProjection,
  workflowClock,
} from './session-workflow-model';

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

  it('derives dependents once for every step that unblocks another', () => {
    const projection = buildSessionWorkflowProjection(todos, [], []);

    expect(projection.dependentsByTodo.get('prepare')).toEqual([todos[1]]);
    expect(projection.dependentsByTodo.get('build')).toBeUndefined();
  });

  it('ignores self-references and unknown ids when deriving dependents', () => {
    const selfBlocked: TodoItem[] = [
      { id: 'a', content: 'A', status: 'pending', blockedBy: ['a', 'ghost'] },
      { id: 'b', content: 'B', status: 'pending', blockedBy: ['a', 'a'] },
    ];
    const projection = buildSessionWorkflowProjection(selfBlocked, [], []);

    // 'a' unblocks 'b' exactly once despite the duplicate edge, and never
    // itself; 'ghost' is not in the plan so it contributes no entry.
    expect(projection.dependentsByTodo.get('a')).toEqual([selfBlocked[1]]);
    expect(projection.dependentsByTodo.has('ghost')).toBe(false);
  });

  it('files a tool pointing at an unknown step as unassigned', () => {
    const projection = buildSessionWorkflowProjection(
      todos,
      [agentTool('call-ghost', 'ghost')],
      [],
    );

    // The graph routes these into its "unassigned" bucket; the projection
    // must not file them under a key nothing ever reads.
    expect(projection.toolsByTodo.has('ghost')).toBe(false);
    expect(projection.agentToolsByTodo.has('ghost')).toBe(false);
  });
});

describe('workflowClock', () => {
  it('formats in the app language rather than the browser default', () => {
    const at = Date.UTC(2026, 0, 2, 15, 4);

    // en-US renders a 12-hour clock with a day period; de-DE renders 24-hour.
    expect(workflowClock(at, 'en-US')).not.toEqual(workflowClock(at, 'de-DE'));
    expect(workflowClock(undefined, 'en-US')).toBe('--:--');
  });
});

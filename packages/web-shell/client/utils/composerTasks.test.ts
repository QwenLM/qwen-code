import { describe, expect, it } from 'vitest';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { getComposerTaskChipGroups, isComposerTask } from './composerTasks';

const base = {
  id: 'task-1',
  label: 'task',
  description: 'task',
  status: 'running' as const,
  startTime: 0,
  runtimeMs: 0,
};

describe('isComposerTask', () => {
  it('shows non-agent tasks and excludes agents', () => {
    const tasks: Array<[DaemonSessionTaskWithWorkflowStatus, boolean]> = [
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: false,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'agent',
          isBackgrounded: true,
          subagentType: 'general-purpose',
        },
        false,
      ],
      [
        {
          ...base,
          kind: 'shell',
          command: 'npm test',
          cwd: '/workspace',
        },
        true,
      ],
      [
        {
          ...base,
          kind: 'monitor',
          command: 'watch logs',
          eventCount: 0,
          lastEventTime: 0,
          droppedLines: 0,
        },
        true,
      ],
      [
        {
          ...base,
          kind: 'workflow',
          isBackgrounded: true,
          currentPhase: null,
          phaseVisits: [],
          dispatches: [],
          agentsDispatched: 0,
          agentsCompleted: 0,
          tokensSpent: 0,
          tokenBudgetTotal: null,
          recentLogs: [],
          pendingApprovalCount: 0,
        },
        true,
      ],
    ];

    for (const [task, expected] of tasks) {
      expect(isComposerTask(task)).toBe(expected);
    }
  });

  it('excludes retained workflow history', () => {
    // getWorkflowTasks() merges the project's saved runs into the same
    // list. Counting them would present the whole retained history as this
    // session's background work.
    const historical: DaemonSessionTaskWithWorkflowStatus = {
      ...base,
      status: 'completed',
      kind: 'workflow',
      isHistorical: true,
      isBackgrounded: false,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    };
    expect(isComposerTask(historical)).toBe(false);
    expect(isComposerTask({ ...historical, isHistorical: false })).toBe(true);
  });
});

describe('getComposerTaskChipGroups', () => {
  type Status = DaemonSessionTaskWithWorkflowStatus['status'];
  const agent = (
    id: string,
    status: Status,
    isBackgrounded = true,
  ): DaemonSessionTaskWithWorkflowStatus =>
    ({
      ...base,
      id,
      kind: 'agent',
      status,
      isBackgrounded,
      subagentType: 'general-purpose',
    }) as DaemonSessionTaskWithWorkflowStatus;
  const shell = (id: string, status: Status) =>
    ({
      ...base,
      id,
      kind: 'shell',
      status,
      command: 'npm test',
      cwd: '/workspace',
    }) as DaemonSessionTaskWithWorkflowStatus;
  const monitor = (id: string, status: Status) =>
    ({
      ...base,
      id,
      kind: 'monitor',
      status,
    }) as DaemonSessionTaskWithWorkflowStatus;
  const workflow = (id: string, status: Status, isHistorical = false) =>
    ({
      ...base,
      id,
      kind: 'workflow',
      status,
      isHistorical,
      isBackgrounded: true,
      currentPhase: null,
      phaseVisits: [],
      dispatches: [],
      agentsDispatched: 0,
      agentsCompleted: 0,
      tokensSpent: 0,
      tokenBudgetTotal: null,
      recentLogs: [],
      pendingApprovalCount: 0,
    }) as DaemonSessionTaskWithWorkflowStatus;
  const summary = (
    tasks: DaemonSessionTaskWithWorkflowStatus[],
    includeAgents = true,
  ) =>
    getComposerTaskChipGroups(tasks, { includeAgents }).map((group) => [
      group.kind,
      group.tasks.map((task) => task.id),
    ]);

  it('groups unfinished tasks by kind in a fixed order', () => {
    expect(
      summary([
        shell('shell-1', 'running'),
        monitor('monitor-1', 'running'),
        agent('agent-1', 'running'),
        workflow('workflow-1', 'running'),
        agent('agent-2', 'paused'),
        shell('shell-2', 'running'),
        workflow('workflow-2', 'pausing'),
        workflow('workflow-3', 'paused'),
      ]),
    ).toEqual([
      ['workflow', ['workflow-1', 'workflow-2', 'workflow-3']],
      ['agent', ['agent-1']],
      ['shell', ['shell-1', 'shell-2']],
      ['monitor', ['monitor-1']],
    ]);
  });

  it('drops finished tasks so no "done" chip lingers', () => {
    const finished: Status[] = ['completed', 'failed', 'cancelled'];
    expect(
      summary(
        finished.flatMap((status) => [
          shell(`shell-${status}`, status),
          monitor(`monitor-${status}`, status),
          workflow(`workflow-${status}`, status),
          agent(`agent-${status}`, status),
        ]),
      ),
    ).toEqual([]);
  });

  it('leaves out workflow history, foreground agents and parked agents', () => {
    expect(
      summary([
        workflow('history', 'running', true),
        agent('foreground', 'running', false),
        // Paused agents are retained all session; a chip would never clear.
        agent('parked', 'paused'),
      ]),
    ).toEqual([]);
  });

  it('leaves out background agents when the host asks it to', () => {
    expect(
      summary(
        [agent('agent-1', 'running'), shell('shell-1', 'running')],
        false,
      ),
    ).toEqual([['shell', ['shell-1']]]);
  });
});

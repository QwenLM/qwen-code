/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentTask,
  Config,
  MonitorTask,
  WorkflowSnapshot,
  WorkflowTask,
} from '@qwen-code/qwen-code-core';
import { buildSessionTasksStatus } from './tasksSnapshot.js';
import type { ServeSessionAgentTaskStatus } from '@qwen-code/acp-bridge/status';

function agentTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    kind: 'agent',
    id: 'agent-1',
    agentId: 'agent-1',
    description: 'test agent',
    status: 'running',
    startTime: 1_000,
    outputFile: '/tmp/agent-1.jsonl',
    subagentType: 'general-purpose',
    isBackgrounded: false,
    pendingMessages: [],
    ...overrides,
  } as AgentTask;
}

function configWith(
  agents: AgentTask[],
  workflows: WorkflowTask[] = [],
): Config {
  return {
    getBackgroundTaskRegistry: () => ({ getAll: () => agents }),
    getBackgroundShellRegistry: () => ({ getAll: () => [] }),
    getMonitorRegistry: () => ({ getAll: () => [] }),
    getWorkflowRunRegistry: () => ({ list: () => workflows }),
  } as unknown as Config;
}

function workflowSnapshot(
  overrides: Partial<WorkflowSnapshot> = {},
): WorkflowSnapshot {
  return {
    runId: 'wf_saved',
    meta: { name: 'review-and-fix', description: 'Review and fix' },
    status: 'failed',
    script: 'return 1;',
    phases: ['Inspect'],
    phaseVisits: [
      {
        id: 'phase-1',
        index: 0,
        title: 'Inspect',
        startedAt: 500,
        endedAt: 900,
      },
    ],
    dispatches: [],
    agentsDispatched: 2,
    agentsCompleted: 1,
    tokensSpent: 900,
    tokenBudgetTotal: 4_000,
    perPhaseTokens: [],
    recentLogs: [],
    events: [
      {
        id: 'event-1',
        type: 'workflow-failed',
        at: 1_000,
        error: 'Review failed',
      },
    ],
    startTime: 500,
    endTime: 1_000,
    ...overrides,
  };
}

function serializedMonitor(
  monitor: MonitorTask,
): Extract<
  ReturnType<typeof buildSessionTasksStatus>['tasks'][number],
  { kind: 'monitor' }
> {
  const config = {
    getBackgroundTaskRegistry: () => ({ getAll: () => [] }),
    getBackgroundShellRegistry: () => ({ getAll: () => [] }),
    getMonitorRegistry: () => ({ getAll: () => [monitor] }),
    getWorkflowRunRegistry: () => ({ list: () => [] }),
  } as unknown as Config;
  return buildSessionTasksStatus('session-1', config, 2_000).tasks.find(
    (task) => task.kind === 'monitor',
  ) as Extract<
    ReturnType<typeof buildSessionTasksStatus>['tasks'][number],
    { kind: 'monitor' }
  >;
}

function serializedAgents(agents: AgentTask[]): ServeSessionAgentTaskStatus[] {
  const snapshot = buildSessionTasksStatus(
    'session-1',
    configWith(agents),
    2_000,
  );
  return snapshot.tasks.filter(
    (t): t is ServeSessionAgentTaskStatus => t.kind === 'agent',
  );
}

describe('buildSessionTasksStatus agent lineage', () => {
  it('carries parentAgentId, parentName and depth for a nested agent', () => {
    const [parent, child] = serializedAgents([
      agentTask({ id: 'parent-1', agentId: 'parent-1' }),
      agentTask({
        id: 'child-1',
        agentId: 'child-1',
        parentAgentId: 'parent-1',
        parentName: 'general-purpose',
        depth: 1,
        startTime: 1_500,
      }),
    ]);
    expect(parent.parentAgentId).toBeUndefined();
    expect(child.parentAgentId).toBe('parent-1');
    expect(child.parentName).toBe('general-purpose');
    expect(child.depth).toBe(1);
  });

  it('normalizes a null parentAgentId (top-level launch) to absent', () => {
    const [task] = serializedAgents([agentTask({ parentAgentId: null })]);
    expect('parentAgentId' in task).toBe(false);
  });

  it('omits all lineage keys for legacy entries without them', () => {
    const [task] = serializedAgents([agentTask()]);
    expect('parentAgentId' in task).toBe(false);
    expect('parentName' in task).toBe(false);
    expect('depth' in task).toBe(false);
  });

  it('serializes depth 0 explicitly rather than dropping it', () => {
    const [task] = serializedAgents([
      agentTask({ parentAgentId: null, depth: 0 }),
    ]);
    expect(task.depth).toBe(0);
  });

  it('exposes the parent tool call that launched an agent', () => {
    const [task] = serializedAgents([agentTask({ toolUseId: 'call-1' })]);
    expect(task.toolUseId).toBe('call-1');
  });
});

describe('buildSessionTasksStatus monitor correlation', () => {
  it('exposes the tool call that launched a monitor', () => {
    const task = serializedMonitor({
      kind: 'monitor',
      id: 'mon_0123456789abcdef',
      description: 'watch logs',
      status: 'running',
      startTime: 1_000,
      command: 'tail -f app.log',
      eventCount: 0,
      lastEventTime: 1_000,
      droppedLines: 0,
      toolUseId: 'monitor-call-1',
    } as MonitorTask);

    expect(task.toolUseId).toBe('monitor-call-1');
  });
});

describe('buildSessionTasksStatus workflow graph', () => {
  it('omits workflow tasks unless the caller opts in', () => {
    const snapshot = buildSessionTasksStatus(
      'session-1',
      configWith([]),
      2_000,
      [workflowSnapshot()],
    );

    expect(snapshot.tasks).toEqual([]);
  });

  it('exposes phase visits and dispatch dependencies from the workflow registry', () => {
    const workflow = {
      kind: 'workflow',
      id: 'wf_graph',
      runId: 'wf_graph',
      toolUseId: 'workflow-call-1',
      description: 'Review and fix',
      meta: { name: 'review-and-fix', description: 'Review and fix' },
      status: 'running',
      startTime: 1_000,
      isBackgrounded: true,
      currentPhase: 'Review',
      phases: ['Inspect', 'Review'],
      phaseVisits: [
        {
          id: 'phase-1',
          index: 0,
          title: 'Inspect',
          startedAt: 1_000,
          endedAt: 1_200,
        },
        { id: 'phase-2', index: 1, title: 'Review', startedAt: 1_200 },
      ],
      currentPhaseVisitId: 'phase-2',
      dispatches: [
        {
          id: 'dispatch-1',
          phaseVisitId: 'phase-1',
          label: 'Scope mapper',
          prompt: 'Inspect the repository',
          status: 'completed',
          dependsOn: [],
          queuedAt: 1_010,
          startedAt: 1_020,
          endedAt: 1_100,
        },
        {
          id: 'dispatch-2',
          phaseVisitId: 'phase-2',
          label: 'Correctness',
          prompt: 'Review correctness',
          subagentId: 'correctness-agent-1',
          status: 'running',
          dependsOn: ['dispatch-1'],
          queuedAt: 1_210,
          startedAt: 1_220,
        },
      ],
      agentsDispatched: 2,
      agentsCompleted: 1,
      recentLogs: ['Review started'],
      events: [
        {
          id: 'event-1',
          type: 'log',
          at: 1_250,
          message: 'Review started',
        },
        {
          id: 'event-2',
          type: 'approval-requested',
          at: 1_300,
          name: 'write_file',
          dispatchId: 'dispatch-2',
        },
      ],
      tokensSpent: 1_200,
      tokenBudgetTotal: 8_000,
      perPhaseTokens: new Map(),
      script: '',
      workflowName: 'review-and-fix',
      sourceRunId: 'wf_source',
      startMode: 'rerun',
      pendingApprovals: [
        {
          approvalId: 'wfap-1',
          subagentId: 'correctness-agent-1',
          callId: 'call-1',
          name: 'write_file',
          description: 'Update the implementation',
          confirmationDetails: {} as never,
          at: 1_300,
        },
      ],
      outputOffset: 0,
      notified: false,
      outputFile: '',
      abortController: new AbortController(),
    } as WorkflowTask;

    const snapshot = buildSessionTasksStatus(
      'session-1',
      configWith([], [workflow]),
      2_000,
      [],
      { includeWorkflows: true },
    );
    const task = snapshot.tasks.find(
      (candidate) => candidate.kind === 'workflow',
    );

    expect(task).toMatchObject({
      kind: 'workflow',
      id: 'wf_graph',
      toolUseId: 'workflow-call-1',
      workflowName: 'review-and-fix',
      label: 'review-and-fix',
      currentPhase: 'Review',
      agentsDispatched: 2,
      agentsCompleted: 1,
      tokensSpent: 1_200,
      tokenBudgetTotal: 8_000,
      sourceRunId: 'wf_source',
      startMode: 'rerun',
      phaseVisits: [
        { id: 'phase-1', title: 'Inspect' },
        { id: 'phase-2', title: 'Review' },
      ],
      dispatches: [
        { id: 'dispatch-1', status: 'completed', dependsOn: [] },
        {
          id: 'dispatch-2',
          status: 'running',
          subagentId: 'correctness-agent-1',
          dependsOn: ['dispatch-1'],
        },
      ],
      pendingApprovalCount: 1,
      pendingApprovals: [
        {
          approvalId: 'wfap-1',
          subagentId: 'correctness-agent-1',
          name: 'write_file',
          description: 'Update the implementation',
        },
      ],
      events: [
        {
          id: 'event-1',
          type: 'log',
          at: 1_250,
          message: 'Review started',
        },
        {
          id: 'event-2',
          type: 'approval-requested',
          at: 1_300,
          name: 'write_file',
          dispatchId: 'dispatch-2',
        },
      ],
    });
  });

  it('restores persisted workflow runs as read-only task history', () => {
    const snapshot = buildSessionTasksStatus(
      'session-1',
      configWith([]),
      2_000,
      [workflowSnapshot()],
      { includeWorkflows: true },
    );

    expect(snapshot.tasks).toEqual([
      expect.objectContaining({
        kind: 'workflow',
        id: 'wf_saved',
        label: 'review-and-fix',
        status: 'failed',
        runtimeMs: 500,
        isHistorical: true,
        agentsDispatched: 2,
        agentsCompleted: 1,
        tokensSpent: 900,
        events: [
          {
            id: 'event-1',
            type: 'workflow-failed',
            at: 1_000,
            error: 'Review failed',
          },
        ],
      }),
    ]);
  });

  it('prefers the in-memory workflow task over a persisted duplicate', () => {
    const workflow = {
      kind: 'workflow',
      id: 'wf_saved',
      runId: 'wf_saved',
      description: 'Live entry',
      meta: { name: 'review-and-fix', description: 'Review and fix' },
      status: 'completed',
      startTime: 500,
      endTime: 1_100,
      isBackgrounded: true,
      currentPhase: null,
      phases: [],
      phaseVisits: [],
      currentPhaseVisitId: null,
      dispatches: [],
      agentsDispatched: 3,
      agentsCompleted: 3,
      recentLogs: [],
      events: [],
      tokensSpent: 1_200,
      tokenBudgetTotal: 4_000,
      perPhaseTokens: new Map(),
      script: '',
      pendingApprovals: [],
      outputOffset: 0,
      notified: true,
      outputFile: '',
      abortController: new AbortController(),
    } as WorkflowTask;

    const snapshot = buildSessionTasksStatus(
      'session-1',
      configWith([], [workflow]),
      2_000,
      [workflowSnapshot()],
      { includeWorkflows: true },
    );
    const workflows = snapshot.tasks.filter(
      (candidate) => candidate.kind === 'workflow',
    );

    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({
      id: 'wf_saved',
      agentsCompleted: 3,
      tokensSpent: 1_200,
    });
    expect(workflows[0]).not.toHaveProperty('isHistorical');
  });
});

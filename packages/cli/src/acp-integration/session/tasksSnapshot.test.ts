/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentTask,
  Config,
  MonitorTask,
  WorkflowSnapshot,
  WorkflowTask,
} from '@qwen-code/qwen-code-core';
import {
  buildSessionAgentsStatus,
  buildSessionTasksStatus,
} from './tasksSnapshot.js';
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
  projectDir = '/tmp',
): Config {
  return {
    storage: { getProjectDir: () => projectDir },
    getBackgroundTaskRegistry: () => ({ getAll: () => agents }),
    getBackgroundShellRegistry: () => ({ getAll: () => [] }),
    getMonitorRegistry: () => ({ getAll: () => [] }),
    getWorkflowRunRegistry: () => ({ list: () => workflows }),
  } as unknown as Config;
}

describe('buildSessionAgentsStatus', () => {
  it('merges persisted agents with live registry entries by id', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const writeMeta = (id: string, value: Record<string, unknown>) =>
      fs.writeFileSync(
        path.join(sessionDir, `agent-${id}.meta.json`),
        JSON.stringify({
          agentId: id,
          agentType: 'general-purpose',
          description: `stored ${id}`,
          parentSessionId: 'session-1',
          parentAgentId: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          status: 'completed',
          isBackgrounded: true,
          lastUpdatedAt: '2026-08-26T00:00:01.000Z',
          ...value,
        }),
      );
    try {
      writeMeta('stored', {});
      writeMeta('live', { status: 'failed' });
      writeMeta('background-running', { status: 'running' });
      writeMeta('foreground-running', {
        status: 'running',
        isBackgrounded: false,
      });
      writeMeta('missing-status', { status: undefined });
      writeMeta('wrong-parent', { parentSessionId: 'session-2' });
      const snapshot = await buildSessionAgentsStatus(
        'session-1',
        configWith(
          [
            agentTask({
              id: 'live',
              agentId: 'live',
              description: 'live entry',
            }),
          ],
          [],
          projectDir,
        ),
        Date.parse('2026-08-26T00:00:02.000Z'),
      );

      expect(snapshot.tasks.map((task) => task.id).sort()).toEqual([
        'background-running',
        'live',
        'stored',
      ]);
      expect(
        snapshot.tasks.find((task) => task.id === 'background-running'),
      ).toMatchObject({ status: 'paused', isBackgrounded: true });
      expect(snapshot.tasks.find((task) => task.id === 'stored')).toMatchObject(
        {
          status: 'completed',
          outputFile: path.join(sessionDir, 'agent-stored.jsonl'),
        },
      );
      expect(snapshot.tasks.find((task) => task.id === 'live')).toMatchObject({
        status: 'running',
        description: 'live entry',
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('retains only the newest terminal sidecars', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      for (let index = 0; index < 33; index += 1) {
        fs.writeFileSync(
          path.join(sessionDir, `agent-agent-${index}.meta.json`),
          JSON.stringify({
            agentId: `agent-${index}`,
            agentType: 'general-purpose',
            description: `stored ${index}`,
            parentSessionId: 'session-1',
            parentAgentId: null,
            createdAt: '2026-08-26T00:00:00.000Z',
            status: 'completed',
            isBackgrounded: true,
            lastUpdatedAt: new Date(
              Date.parse('2026-08-26T00:00:00.000Z') + index,
            ).toISOString(),
          }),
        );
      }

      const snapshot = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );

      expect(snapshot.tasks).toHaveLength(32);
      expect(snapshot.tasks.some((task) => task.id === 'agent-0')).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('refreshes a cached sidecar after an in-place status update', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    const metaPath = path.join(sessionDir, 'agent-stored.meta.json');
    const meta = {
      agentId: 'stored',
      agentType: 'general-purpose',
      description: 'stored agent',
      parentSessionId: 'session-1',
      parentAgentId: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      status: 'running' as const,
      isBackgrounded: true,
    };
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      const first = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );
      expect(first.tasks[0]?.status).toBe('paused');

      const directoryMtimeNs = fs.statSync(sessionDir, {
        bigint: true,
      }).mtimeNs;
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          ...meta,
          status: 'completed',
          lastUpdatedAt: '2026-08-26T00:00:01.000Z',
        }),
      );
      expect(fs.statSync(sessionDir, { bigint: true }).mtimeNs).toBe(
        directoryMtimeNs,
      );
      const second = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );
      expect(second.tasks[0]?.status).toBe('completed');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not cache a transient sidecar read failure', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    const metaPath = path.join(sessionDir, 'agent-stored.meta.json');
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          agentId: 'stored',
          agentType: 'general-purpose',
          description: 'stored agent',
          parentSessionId: 'session-1',
          parentAgentId: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          status: 'completed',
          isBackgrounded: true,
        }),
      );
      vi.spyOn(fs.promises, 'readFile').mockRejectedValueOnce(
        Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
      );

      const first = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );
      vi.restoreAllMocks();
      const second = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );

      expect(first.tasks).toEqual([]);
      expect(second.tasks.map((task) => task.id)).toEqual(['stored']);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not share cached sidecars between colliding session directories', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'feat_x');
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'agent-stored.meta.json'),
        JSON.stringify({
          agentId: 'stored',
          agentType: 'general-purpose',
          description: 'stored agent',
          parentSessionId: 'feat.x',
          parentAgentId: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          status: 'completed',
          isBackgrounded: true,
        }),
      );

      expect(
        (
          await buildSessionAgentsStatus(
            'feat.x',
            configWith([], [], projectDir),
          )
        ).tasks,
      ).toHaveLength(1);
      expect(
        (
          await buildSessionAgentsStatus(
            'feat_x',
            configWith([], [], projectDir),
          )
        ).tasks,
      ).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('freezes a persisted paused agent duration at its last update', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'agent-paused.meta.json'),
        JSON.stringify({
          agentId: 'paused',
          agentType: 'general-purpose',
          description: 'paused agent',
          parentSessionId: 'session-1',
          parentAgentId: null,
          createdAt: '2026-08-26T00:00:00.000Z',
          lastUpdatedAt: '2026-08-26T00:00:01.000Z',
          status: 'running',
          isBackgrounded: true,
        }),
      );

      const first = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
        Date.parse('2026-08-26T00:00:02.000Z'),
      );
      const cached = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
        Date.parse('2026-08-26T00:01:00.000Z'),
      );

      expect(first.tasks[0]).toMatchObject({
        status: 'paused',
        runtimeMs: 1_000,
      });
      expect(cached.tasks[0]).toMatchObject({
        status: 'paused',
        runtimeMs: 1_000,
      });
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('retains only the newest paused sidecars', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-'));
    const sessionDir = path.join(projectDir, 'subagents', 'session-1');
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      for (let index = 0; index < 33; index += 1) {
        fs.writeFileSync(
          path.join(sessionDir, `agent-paused-${index}.meta.json`),
          JSON.stringify({
            agentId: `paused-${index}`,
            agentType: 'general-purpose',
            description: `paused ${index}`,
            parentSessionId: 'session-1',
            parentAgentId: null,
            createdAt: '2026-08-26T00:00:00.000Z',
            lastUpdatedAt: new Date(
              Date.parse('2026-08-26T00:00:00.000Z') + index,
            ).toISOString(),
            status: 'paused',
            isBackgrounded: true,
          }),
        );
      }

      const snapshot = await buildSessionAgentsStatus(
        'session-1',
        configWith([], [], projectDir),
      );

      expect(snapshot.tasks).toHaveLength(32);
      expect(snapshot.tasks.some((task) => task.id === 'paused-0')).toBe(false);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

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

  it('uses the saved name before metadata is available and exposes the workflow graph', () => {
    const workflow = {
      kind: 'workflow',
      id: 'wf_graph',
      runId: 'wf_graph',
      toolUseId: 'workflow-call-1',
      description: 'wf_graph',
      meta: null,
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
      [
        workflowSnapshot({
          meta: null,
          toolUseId: 'workflow-call-1',
          workflowName: 'review-and-fix',
          description: 'wf_saved',
        }),
      ],
      { includeWorkflows: true },
    );

    expect(snapshot.tasks).toEqual([
      expect.objectContaining({
        kind: 'workflow',
        id: 'wf_saved',
        toolUseId: 'workflow-call-1',
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

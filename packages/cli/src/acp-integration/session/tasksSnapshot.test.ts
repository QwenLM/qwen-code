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
  ShellTask,
} from '@qwen-code/qwen-code-core';
import { buildSessionTasksStatus } from './tasksSnapshot.js';
import type {
  ServeSessionAgentTaskStatus,
  ServeSessionShellTaskStatus,
} from '@qwen-code/acp-bridge/status';

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

function configWith(agents: AgentTask[]): Config {
  return {
    getBackgroundTaskRegistry: () => ({ getAll: () => agents }),
    getBackgroundShellRegistry: () => ({ getAll: () => [] }),
    getMonitorRegistry: () => ({ getAll: () => [] }),
  } as unknown as Config;
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

function shellTask(overrides: Partial<ShellTask> = {}): ShellTask {
  return {
    kind: 'shell',
    id: 'bg_0123456789abcdef',
    shellId: 'bg_0123456789abcdef',
    command: 'python3 app.py',
    description: 'python3 app.py',
    status: 'running',
    startTime: 1_000,
    outputFile: '/tmp/shell-bg.output',
    cwd: '/work',
    abortController: new AbortController(),
    ...overrides,
  } as unknown as ShellTask;
}

function serializedShell(shell: ShellTask): ServeSessionShellTaskStatus {
  const config = {
    getBackgroundTaskRegistry: () => ({ getAll: () => [] }),
    getBackgroundShellRegistry: () => ({ getAll: () => [shell] }),
    getMonitorRegistry: () => ({ getAll: () => [] }),
  } as unknown as Config;
  return buildSessionTasksStatus('session-1', config, 2_000).tasks.find(
    (task) => task.kind === 'shell',
  ) as ServeSessionShellTaskStatus;
}

describe('buildSessionTasksStatus shell tasks', () => {
  it('passes terminal metadata through for tmux-backed tasks', () => {
    const task = serializedShell(
      shellTask({
        terminal: { socket: 'qwen-serve', tmuxSession: 'qsh-bg_x' },
      }),
    );
    expect(task.terminal).toEqual({
      socket: 'qwen-serve',
      tmuxSession: 'qsh-bg_x',
    });
  });

  it('omits terminal for plain shell tasks', () => {
    const task = serializedShell(shellTask());
    expect('terminal' in task).toBe(false);
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

import { describe, expect, it } from 'vitest';
import type { DaemonSessionTaskStatus } from '@qwen-code/sdk/daemon';
import { getTaskPillLabel } from './StatusBar';

const messages: Record<string, (count: number) => string> = {
  'tasks.pill.agent': (count) => `${count} local agent`,
  'tasks.pill.agents': (count) => `${count} local agents`,
  'tasks.pill.agentPaused': (count) => `${count} local agent paused`,
  'tasks.pill.agentsPaused': (count) => `${count} local agents paused`,
  'tasks.pill.done': (count) => `${count} task done`,
  'tasks.pill.doneMany': (count) => `${count} tasks done`,
  'tasks.pill.monitor': (count) => `${count} monitor`,
  'tasks.pill.monitors': (count) => `${count} monitors`,
  'tasks.pill.shell': (count) => `${count} shell`,
  'tasks.pill.shells': (count) => `${count} shells`,
};

function t(key: string, vars?: Record<string, string | number>) {
  return messages[key]?.(Number(vars?.count ?? 0)) ?? key;
}

function baseTask(kind: DaemonSessionTaskStatus['kind']) {
  return {
    id: `${kind}-${Math.random()}`,
    label: kind,
    description: kind,
    startTime: 1,
    runtimeMs: 1,
  };
}

function agentTask(
  status: Extract<DaemonSessionTaskStatus, { kind: 'agent' }>['status'],
): DaemonSessionTaskStatus {
  return {
    ...baseTask('agent'),
    kind: 'agent',
    status,
    isBackgrounded: true,
  };
}

function shellTask(
  status: Extract<DaemonSessionTaskStatus, { kind: 'shell' }>['status'],
): DaemonSessionTaskStatus {
  return {
    ...baseTask('shell'),
    kind: 'shell',
    status,
    command: 'echo ok',
    cwd: '.',
  };
}

function monitorTask(
  status: Extract<DaemonSessionTaskStatus, { kind: 'monitor' }>['status'],
): DaemonSessionTaskStatus {
  return {
    ...baseTask('monitor'),
    kind: 'monitor',
    status,
    command: 'tail -f app.log',
    eventCount: 0,
    lastEventTime: 1,
    droppedLines: 0,
  };
}

describe('getTaskPillLabel', () => {
  it('groups running tasks with shell first', () => {
    expect(
      getTaskPillLabel(
        [
          agentTask('running'),
          shellTask('running'),
          shellTask('running'),
          monitorTask('completed'),
        ],
        t,
      ),
    ).toBe('2 shells, 1 local agent');
  });

  it('shows paused agents when no task is running', () => {
    expect(
      getTaskPillLabel([agentTask('paused'), shellTask('completed')], t),
    ).toBe('1 local agent paused');
  });

  it('shows generic done label when every task is terminal', () => {
    expect(
      getTaskPillLabel([shellTask('completed'), monitorTask('failed')], t),
    ).toBe('2 tasks done');
  });
});

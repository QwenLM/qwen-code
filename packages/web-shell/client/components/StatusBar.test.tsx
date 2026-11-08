// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DaemonSessionTaskWithWorkflowStatus } from '@qwen-code/sdk/daemon';
import { getTranslator } from '../i18n';
import { getTaskPillLabel } from './StatusBar';

const t = getTranslator('en');

const base = {
  id: 'task-1',
  label: 'task',
  description: 'task',
  startTime: 0,
  runtimeMs: 0,
};

function agentTask(
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
  isBackgrounded: boolean,
  id?: string,
): DaemonSessionTaskWithWorkflowStatus {
  return {
    ...base,
    id: id ?? `agent-${status}-${isBackgrounded ? 'bg' : 'fg'}`,
    kind: 'agent',
    status,
    isBackgrounded,
  } as DaemonSessionTaskWithWorkflowStatus;
}

function shellTask(
  status: 'running' | 'paused' | 'completed',
  id?: string,
): DaemonSessionTaskWithWorkflowStatus {
  return {
    ...base,
    id: id ?? `shell-${status}`,
    kind: 'shell',
    status,
    command: 'npm test',
    cwd: '/workspace',
  } as DaemonSessionTaskWithWorkflowStatus;
}

describe('getTaskPillLabel', () => {
  it('returns an empty label with no tasks', () => {
    expect(getTaskPillLabel([], t)).toBe('');
  });

  it('counts running background agents only', () => {
    const tasks = [
      agentTask('running', true, 'a1'),
      agentTask('running', true, 'a2'),
      agentTask('running', true, 'a3'),
    ];
    expect(getTaskPillLabel(tasks, t)).toBe('3 local agents');
  });

  it('uses the singular form for one running background agent', () => {
    expect(getTaskPillLabel([agentTask('running', true)], t)).toBe(
      '1 local agent',
    );
  });

  it('joins agent count with the existing running task counts', () => {
    const tasks = [
      shellTask('running'),
      agentTask('running', true, 'a1'),
      agentTask('paused', true, 'a2'),
    ];
    expect(getTaskPillLabel(tasks, t)).toBe(
      '1 shell, 1 local agent, 1 local agent paused',
    );
  });

  it('labels paused background agents as paused', () => {
    expect(getTaskPillLabel([agentTask('paused', true)], t)).toBe(
      '1 local agent paused',
    );
  });

  it('joins running and paused agent counts', () => {
    const tasks = [
      agentTask('running', true, 'a1'),
      agentTask('paused', true, 'a2'),
      agentTask('paused', true, 'a3'),
    ];
    expect(getTaskPillLabel(tasks, t)).toBe(
      '1 local agent, 2 local agents paused',
    );
  });

  it('lets a paused agent show instead of the done count', () => {
    const tasks = [shellTask('completed'), agentTask('paused', true)];
    expect(getTaskPillLabel(tasks, t)).toBe('1 local agent paused');
  });

  it('does not count foreground agents', () => {
    expect(getTaskPillLabel([agentTask('running', false)], t)).toBe('');
  });

  it('does not count terminal background agents', () => {
    const tasks = [
      agentTask('completed', true, 'a1'),
      agentTask('failed', true, 'a2'),
      agentTask('cancelled', true, 'a3'),
    ];
    expect(getTaskPillLabel(tasks, t)).toBe('');
  });

  it('lets a running agent win over the done count', () => {
    const tasks = [shellTask('completed'), agentTask('running', true)];
    expect(getTaskPillLabel(tasks, t)).toBe('1 local agent');
  });

  it('keeps the done count free of terminal agents', () => {
    const tasks = [shellTask('completed'), agentTask('completed', true)];
    expect(getTaskPillLabel(tasks, t)).toBe('1 task done');
  });

  it('keeps the existing running and done labels unchanged', () => {
    expect(getTaskPillLabel([shellTask('running')], t)).toBe('1 shell');
    expect(
      getTaskPillLabel([shellTask('completed'), shellTask('completed')], t),
    ).toBe('2 tasks done');
  });
});

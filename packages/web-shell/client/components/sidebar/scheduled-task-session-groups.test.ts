import { describe, expect, it } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { getScheduledTaskSessionGroup } from './scheduled-task-session-groups';

describe('getScheduledTaskSessionGroup', () => {
  it('uses the task id and removes the generated run-time suffix', () => {
    expect(
      getScheduledTaskSessionGroup({
        sessionId: 'run-1',
        sourceType: 'default',
        sourceId: 'scheduled_task_run:task-1',
        displayName: 'Review PRs · 08-31 09:30',
      } as DaemonSessionSummary),
    ).toEqual({
      id: 'scheduled-task:task-1',
      label: 'Review PRs',
    });
  });

  it('falls back to the task id when the display name is missing or blank', () => {
    expect(
      getScheduledTaskSessionGroup({
        sessionId: 'run-1',
        sourceType: 'default',
        sourceId: 'scheduled_task_run:task-1',
      } as DaemonSessionSummary),
    ).toEqual({ id: 'scheduled-task:task-1', label: 'task-1' });
    expect(
      getScheduledTaskSessionGroup({
        sessionId: 'run-1',
        sourceType: 'default',
        sourceId: 'scheduled_task_run:task-1',
        displayName: '   ',
      } as DaemonSessionSummary),
    ).toEqual({ id: 'scheduled-task:task-1', label: 'task-1' });
  });

  it('does not group ordinary or malformed sessions', () => {
    const base = { sessionId: 'run-1', sourceType: 'default' };
    expect(
      getScheduledTaskSessionGroup(base as DaemonSessionSummary),
    ).toBeUndefined();
    expect(
      getScheduledTaskSessionGroup({
        ...base,
        sourceId: 'scheduled_task_run:',
      } as DaemonSessionSummary),
    ).toBeUndefined();
    expect(
      getScheduledTaskSessionGroup({
        ...base,
        sourceType: 'channel',
        sourceId: 'scheduled_task_run:task-1',
      } as DaemonSessionSummary),
    ).toBeUndefined();
  });
});

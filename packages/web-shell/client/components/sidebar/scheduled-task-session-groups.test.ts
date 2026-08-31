import { describe, expect, it } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import {
  collectScheduledTaskSession,
  getScheduledTaskSessionGroup,
} from './scheduled-task-session-groups';

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

describe('collectScheduledTaskSession', () => {
  const run = (sessionId: string, displayName: string) =>
    ({
      sessionId,
      sourceType: 'default',
      sourceId: 'scheduled_task_run:task-1',
      displayName,
    }) as DaemonSessionSummary;

  it('prefers the generated task title over a rename regardless of collection order', () => {
    const renamedFirst = new Map();
    collectScheduledTaskSession(
      renamedFirst,
      run('run-1', 'Investigate flake'),
    );
    collectScheduledTaskSession(
      renamedFirst,
      run('run-2', 'Hourly review · 08-31 09:30'),
    );
    expect(renamedFirst.get('scheduled-task:task-1')?.label).toBe(
      'Hourly review',
    );
    expect(
      renamedFirst
        .get('scheduled-task:task-1')
        ?.sessions.map((s) => s.sessionId),
    ).toEqual(['run-1', 'run-2']);

    const generatedFirst = new Map();
    collectScheduledTaskSession(
      generatedFirst,
      run('run-2', 'Hourly review · 08-31 09:30'),
    );
    collectScheduledTaskSession(
      generatedFirst,
      run('run-1', 'Investigate flake'),
    );
    expect(generatedFirst.get('scheduled-task:task-1')?.label).toBe(
      'Hourly review',
    );
    expect(
      generatedFirst
        .get('scheduled-task:task-1')
        ?.sessions.map((s) => s.sessionId),
    ).toEqual(['run-2', 'run-1']);
  });

  it('keeps the first rename as the label when no run carries the generated shape', () => {
    const sections = new Map();
    collectScheduledTaskSession(sections, run('run-1', 'First rename'));
    collectScheduledTaskSession(sections, run('run-2', 'Second rename'));
    expect(sections.get('scheduled-task:task-1')?.label).toBe('First rename');
    expect(sections.get('scheduled-task:task-1')?.sessions).toHaveLength(2);
  });
});

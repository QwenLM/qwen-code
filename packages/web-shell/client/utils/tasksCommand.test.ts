import { describe, expect, it, vi } from 'vitest';
import type { DaemonSessionTasksStatus } from '@qwen-code/sdk/daemon';
import {
  parseTasksStatusMessage,
  serializeTasksStatusMessage,
} from '../components/messages/TasksStatusMessage';
import { handleTasksSlashCommand } from './tasksCommand';

function tasksSnapshot(): DaemonSessionTasksStatus {
  return {
    v: 1,
    sessionId: 'session-1',
    now: 1_700_000_000_000,
    tasks: [],
  };
}

describe('handleTasksSlashCommand', () => {
  it('returns false for other commands', () => {
    expect(
      handleTasksSlashCommand({
        cmd: 'help',
        getTasks: vi.fn(),
        dispatch: vi.fn(),
        reportError: vi.fn(),
      }),
    ).toBe(false);
  });

  it('dispatches a serialized tasks status message', async () => {
    const snapshot = tasksSnapshot();
    const dispatch = vi.fn();

    expect(
      handleTasksSlashCommand({
        cmd: 'tasks',
        getTasks: vi.fn().mockResolvedValue(snapshot),
        dispatch,
        reportError: vi.fn(),
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const event = dispatch.mock.calls[0][0][0];
    expect(event.type).toBe('status');
    expect(parseTasksStatusMessage(event.text)).toEqual({ snapshot });
  });

  it('reports getTasks failures', async () => {
    const error = new Error('boom');
    const reportError = vi.fn();

    expect(
      handleTasksSlashCommand({
        cmd: 'tasks',
        getTasks: vi.fn().mockRejectedValue(error),
        dispatch: vi.fn(),
        reportError,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(error, 'Failed to load tasks'),
    );
  });
});

describe('tasks status message serialization', () => {
  it('round-trips tasks status snapshots', () => {
    const snapshot = tasksSnapshot();
    expect(
      parseTasksStatusMessage(serializeTasksStatusMessage({ snapshot })),
    ).toEqual({ snapshot });
  });
});

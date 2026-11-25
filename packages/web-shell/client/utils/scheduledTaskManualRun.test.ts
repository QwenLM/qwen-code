import { describe, expect, it, vi } from 'vitest';
import type { DaemonScheduledTask } from '@qwen-code/web-shell/daemon-react-sdk';
import { runScheduledTaskManually } from './scheduledTaskManualRun';

function makeTask(
  overrides: Partial<DaemonScheduledTask> = {},
): DaemonScheduledTask {
  return {
    id: 'shared-id',
    name: null,
    cron: '0 9 * * *',
    prompt: 'PROMPT_A',
    recurring: true,
    enabled: true,
    createdAt: 0,
    lastFiredAt: null,
    nextRunAt: null,
    sessionId: 'session-a',
    sessionMode: 'persistent',
    runs: [],
    workspaceId: 'ws-a',
    workspaceCwd: '/workspace/a',
    ...overrides,
  };
}

describe('runScheduledTaskManually owner matching', () => {
  it.each([
    [
      'a different session',
      [makeTask({ sessionId: 'session-b', prompt: 'PROMPT_B' })],
    ],
    ['multiple records for one owner', [makeTask(), makeTask()]],
  ])('refuses a same-id fresh record matching %s', async (_label, tasks) => {
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue(tasks),
      runScheduledTask: vi.fn(),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn();
    const onError = vi.fn();
    const reload = vi.fn();

    await runScheduledTaskManually(
      makeTask(),
      actions,
      onRunPrompt,
      (key) => key,
      {
        reload,
        onError,
      },
    );

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('checks owner selection before admitting a recurring prompt', async () => {
    const task = makeTask();
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn(),
      assertScheduledTaskOwnerSelection: vi
        .fn()
        .mockRejectedValue(new Error('owner selection unsupported')),
    };
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
    });

    expect(actions.assertScheduledTaskOwnerSelection).toHaveBeenCalledWith(
      'session-a',
    );
    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'owner selection unsupported' }),
      'scheduledTasks.error.runFailed',
    );
  });

  it('runs the unique task from the expected session', async () => {
    const task = makeTask();
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
    });

    expect(onRunPrompt).toHaveBeenCalledWith(
      'PROMPT_A',
      'session-a',
      '/workspace/a',
    );
    expect(actions.runScheduledTask).toHaveBeenCalledWith(
      'shared-id',
      'ws-a',
      'session-a',
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

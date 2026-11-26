import { describe, expect, it, vi } from 'vitest';
import type { DaemonScheduledTask } from '@qwen-code/web-shell/daemon-react-sdk';
import {
  createScheduledTaskCancellation,
  runScheduledTaskManually,
} from './scheduledTaskManualRun';

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

  it('does not admit a prompt after deletion during capability negotiation', async () => {
    const task = makeTask();
    let releaseCapability!: () => void;
    let deleted = false;
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn(),
      assertScheduledTaskOwnerSelection: vi.fn().mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseCapability = resolve;
          }),
      ),
    };
    const onRunPrompt = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    const running = runScheduledTaskManually(
      task,
      actions,
      onRunPrompt,
      (key) => key,
      {
        reload: vi.fn(),
        onError,
        isStale: () => deleted,
      },
    );
    await vi.waitFor(() =>
      expect(actions.assertScheduledTaskOwnerSelection).toHaveBeenCalledOnce(),
    );
    deleted = true;
    releaseCapability();
    await running;

    expect(onRunPrompt).not.toHaveBeenCalled();
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { deleted: true, expectedRecordings: 0 },
    { deleted: false, expectedRecordings: 1 },
  ])(
    'checks confirmed deletion ($deleted) after recurring prompt resolution before recording',
    async ({ deleted, expectedRecordings }) => {
      const task = makeTask();
      let stale = false;
      let releaseAdmission!: () => void;
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      const actions = {
        listScheduledTasks: vi.fn().mockResolvedValue([task]),
        runScheduledTask: vi.fn().mockResolvedValue(task),
        assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
      };
      const onRunPrompt = vi.fn().mockReturnValue(admission);
      const onError = vi.fn();

      const running = runScheduledTaskManually(
        task,
        actions,
        onRunPrompt,
        (key) => key,
        {
          reload: vi.fn(),
          onError,
          isStale: () => stale,
        },
      );
      await vi.waitFor(() => expect(onRunPrompt).toHaveBeenCalledOnce());
      stale = deleted;
      releaseAdmission();
      await running;

      expect(actions.runScheduledTask).toHaveBeenCalledTimes(
        expectedRecordings,
      );
      const replayGuard = onRunPrompt.mock.calls[0]?.[3] as
        | (() => boolean)
        | undefined;
      expect(replayGuard?.()).toBe(deleted);
      expect(onRunPrompt).toHaveBeenCalledWith(
        'PROMPT_A',
        'session-a',
        '/workspace/a',
        expect.any(Function),
        expect.any(Function),
      );
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('passes only confirmed deletion as the replay admission guard', async () => {
    const task = makeTask();
    let current = true;
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const isStale = vi.fn().mockReturnValue(false);
    const onRunPrompt = vi.fn(async () => {
      current = false;
    });

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError: vi.fn(),
      isCurrent: () => current,
      isStale,
    });

    expect(onRunPrompt.mock.calls[0]?.[3]).toBe(isStale);
    expect(isStale()).toBe(false);
    expect(actions.runScheduledTask).toHaveBeenCalledExactlyOnceWith(
      'shared-id',
      'ws-a',
      'session-a',
    );
  });

  it('retains HTTP revalidation when confirmed deletion is omitted', async () => {
    const task = makeTask();
    let remoteTask: DaemonScheduledTask | undefined = task;
    const actions = {
      listScheduledTasks: vi.fn(async () => (remoteTask ? [remoteTask] : [])),
      runScheduledTask: vi.fn(),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onError = vi.fn();
    const onRunPrompt = vi.fn(
      async (
        _prompt: string,
        _sessionId: string | null,
        _workspaceCwd?: string,
        taskIsStale?: () => boolean,
        beforeDispatch?: () => void | Promise<void>,
      ) => {
        expect(taskIsStale?.()).toBe(false);
        remoteTask = undefined;
        await beforeDispatch?.();
      },
    );

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
    });

    expect(actions.listScheduledTasks).toHaveBeenCalledTimes(2);
    expect(actions.runScheduledTask).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
      'scheduledTasks.error.runFailed',
    );
  });

  it('R22 records an admitted recurring run after an owner change', async () => {
    const task = makeTask();
    let current = true;
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn().mockImplementation(async () => {
      current = false;
    });

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError: vi.fn(),
      isCurrent: () => current,
      isStale: () => false,
    });

    expect(actions.runScheduledTask).toHaveBeenCalledExactlyOnceWith(
      'shared-id',
      'ws-a',
      'session-a',
    );
  });

  it.each([
    { error: new Error('admission failed'), current: true, reported: true },
    {
      error: new DOMException('target changed', 'AbortError'),
      current: false,
      reported: false,
    },
    {
      error: createScheduledTaskCancellation('runtime replaced'),
      current: true,
      reported: false,
    },
  ])(
    'reports recurring admission failure with cancellation isolation ($reported)',
    async ({ error, current, reported }) => {
      const task = makeTask();
      const actions = {
        listScheduledTasks: vi.fn().mockResolvedValue([task]),
        runScheduledTask: vi.fn(),
        assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
      };
      const onError = vi.fn();
      let scopeCurrent = true;
      const onRunPrompt = vi.fn(async () => {
        scopeCurrent = current;
        throw error;
      });

      await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
        reload: vi.fn(),
        onError,
        isCurrent: () => scopeCurrent,
        isStale: () => false,
      });

      expect(actions.runScheduledTask).not.toHaveBeenCalled();
      if (reported) {
        expect(onError).toHaveBeenCalledExactlyOnceWith(
          error,
          'scheduledTasks.error.runFailed',
        );
      } else {
        expect(onError).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { remainsCurrent: true, admissions: 1, recordings: 1 },
    { remainsCurrent: false, admissions: 0, recordings: 0 },
  ])(
    'checks caller scope across queued revalidation ($remainsCurrent)',
    async ({ remainsCurrent, admissions, recordings }) => {
      const task = makeTask();
      let current = true;
      let releaseRevalidation!: () => void;
      const revalidation = new Promise<void>((resolve) => {
        releaseRevalidation = resolve;
      });
      const actions = {
        listScheduledTasks: vi
          .fn()
          .mockResolvedValueOnce([task])
          .mockImplementationOnce(async () => {
            await revalidation;
            return [task];
          }),
        runScheduledTask: vi.fn().mockResolvedValue(task),
        assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
      };
      let admitted = 0;
      const onRunPrompt = vi.fn(async (...args: unknown[]) => {
        const beforeDispatch = args[4] as
          | (() => void | Promise<void>)
          | undefined;
        await beforeDispatch?.();
        admitted += 1;
      });
      const onError = vi.fn();

      const running = runScheduledTaskManually(
        task,
        actions,
        onRunPrompt,
        (key) => key,
        {
          reload: vi.fn(),
          onError,
          isCurrent: () => current,
          isStale: () => false,
        },
      );
      await vi.waitFor(() => expect(onRunPrompt).toHaveBeenCalledOnce());
      current = remainsCurrent;
      releaseRevalidation();
      await running;

      expect(admitted).toBe(admissions);
      expect(actions.runScheduledTask).toHaveBeenCalledTimes(recordings);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('allows bound one-shot admission across a same-session SDK reload while still rejecting scope changes', async () => {
    const task = makeTask({ recurring: false });
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    let ownerCurrent = true;
    let scopeCurrent = true;
    const onError = vi.fn();
    const onOneShotError = vi.fn();
    const onRunPrompt = vi.fn(
      async (
        _prompt: string,
        _sessionId: string | null,
        _workspaceCwd?: string,
        taskIsStale?: () => boolean,
      ) => {
        // Simulates App.runTaskManually -> loadSidebarSession replacing the
        // SDK DaemonSessionClient instance for the same session/workspace.
        ownerCurrent = false;
        expect(taskIsStale?.()).toBe(false);
        scopeCurrent = false;
        expect(taskIsStale?.()).toBe(true);
      },
    );

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
      onOneShotError,
      isCurrent: () => scopeCurrent,
      isOwnerCurrent: () => ownerCurrent,
      isStale: () => false,
    });

    expect(actions.runScheduledTask).toHaveBeenCalledOnce();
    expect(onRunPrompt).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onOneShotError).not.toHaveBeenCalled();
  });

  it('uses fresh.recurring when surfacing onRunPrompt failure after a concurrent flip to recurring', async () => {
    const staleOneShot = makeTask({ recurring: false });
    const freshRecurring = makeTask({ recurring: true });
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([freshRecurring]),
      runScheduledTask: vi.fn(),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    let ownerCurrent = true;
    const failure = new Error('Timed out waiting for session replay');
    const onRunPrompt = vi.fn(async () => {
      ownerCurrent = false;
      throw failure;
    });
    const onError = vi.fn();

    await runScheduledTaskManually(
      staleOneShot,
      actions,
      onRunPrompt,
      (key) => key,
      {
        reload: vi.fn(),
        onError,
        isCurrent: () => true,
        isOwnerCurrent: () => ownerCurrent,
        isStale: () => false,
      },
    );

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      failure,
      'scheduledTasks.error.runFailed',
    );
  });

  it('surfaces recurring recording failure when the scope remains current', async () => {
    const task = makeTask();
    const recordError = new Error('record failed');
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockRejectedValue(recordError),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn(async () => {});
    const onError = vi.fn();

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
      isCurrent: () => true,
      isStale: () => false,
    });

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      recordError,
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
      expect.any(Function),
      expect.any(Function),
    );
    expect(onRunPrompt.mock.calls[0]?.[3]?.()).toBe(false);
    expect(actions.runScheduledTask).toHaveBeenCalledWith(
      'shared-id',
      'ws-a',
      'session-a',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { crossClientDeleted: true, expectedRecordings: 0 },
    { crossClientDeleted: false, expectedRecordings: 1 },
  ])(
    'revalidates a recurring task before dispatch (crossClientDeleted=$crossClientDeleted)',
    async ({ crossClientDeleted, expectedRecordings }) => {
      const task = makeTask();
      const actions = {
        listScheduledTasks: vi
          .fn()
          .mockResolvedValueOnce([task])
          .mockResolvedValueOnce(crossClientDeleted ? [] : [task]),
        runScheduledTask: vi.fn().mockResolvedValue(task),
        assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
      };
      const onRunPrompt = vi.fn(async (...args: unknown[]) => {
        const beforeDispatch = args[4] as
          | (() => void | Promise<void>)
          | undefined;
        await beforeDispatch?.();
      });
      const onError = vi.fn();

      await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
        reload: vi.fn(),
        onError,
        isStale: () => false,
      });

      expect(actions.listScheduledTasks).toHaveBeenCalledTimes(2);
      expect(actions.listScheduledTasks).toHaveBeenNthCalledWith(2, 'ws-a');
      expect(actions.runScheduledTask).toHaveBeenCalledTimes(
        expectedRecordings,
      );
      if (crossClientDeleted) {
        expect(onError).toHaveBeenCalledOnce();
      } else {
        expect(onError).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['sessionMode', makeTask({ sessionMode: 'per_run' })],
    ['recurring', makeTask({ recurring: false })],
  ])(
    'rejects the old dispatch when %s changes during replay',
    async (_change, changedTask) => {
      const task = makeTask();
      let controllerDispatches = 0;
      const actions = {
        listScheduledTasks: vi
          .fn()
          .mockResolvedValueOnce([task])
          .mockResolvedValueOnce([changedTask]),
        runScheduledTask: vi.fn(),
        assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
      };
      const onRunPrompt = vi.fn(async (...args: unknown[]) => {
        const beforeDispatch = args[4] as
          | (() => void | Promise<void>)
          | undefined;
        await beforeDispatch?.();
        controllerDispatches++;
      });
      const onError = vi.fn();

      await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
        reload: vi.fn(),
        onError,
        isStale: () => false,
      });

      expect(controllerDispatches).toBe(0);
      expect(actions.runScheduledTask).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledOnce();
    },
  );

  it('does not re-list a consumed one-shot before prompt dispatch', async () => {
    const task = makeTask({ recurring: false });
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValueOnce([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn(async (...args: unknown[]) => {
      const beforeDispatch = args[4] as
        | (() => void | Promise<void>)
        | undefined;
      await beforeDispatch?.();
    });
    const onError = vi.fn();

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError,
    });

    expect(actions.listScheduledTasks).toHaveBeenCalledOnce();
    expect(actions.runScheduledTask).toHaveBeenCalledOnce();
    expect(onRunPrompt).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves one-shot owner cancellation separately from deletion', async () => {
    const task = makeTask({ recurring: false });
    let current = true;
    let deleted = false;
    const actions = {
      listScheduledTasks: vi.fn().mockResolvedValue([task]),
      runScheduledTask: vi.fn().mockResolvedValue(task),
      assertScheduledTaskOwnerSelection: vi.fn().mockResolvedValue(undefined),
    };
    const onRunPrompt = vi.fn(async () => {
      current = false;
    });

    await runScheduledTaskManually(task, actions, onRunPrompt, (key) => key, {
      reload: vi.fn(),
      onError: vi.fn(),
      isCurrent: () => current,
      isStale: () => deleted,
    });

    const replayGuard = onRunPrompt.mock.calls[0]?.[3] as
      | (() => boolean)
      | undefined;
    expect(replayGuard?.()).toBe(true);
    deleted = true;
    current = true;
    expect(replayGuard?.()).toBe(true);
    expect(actions.runScheduledTask).toHaveBeenCalledOnce();
  });
});

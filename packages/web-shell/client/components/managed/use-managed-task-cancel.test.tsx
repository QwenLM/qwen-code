// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedTask,
  ManagedTaskCancelOperation,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { task, taskOperation } from './managed-task.test-fixtures';
import { useManagedTaskCancel } from './use-managed-task-cancel';

describe('useManagedTaskCancel', () => {
  let root: Root;
  let provider: ManagedAgentProvider;
  let current: ReturnType<typeof useManagedTaskCancel>;
  let sessionId: string;
  let snapshots: ManagedTask[];
  let refresh: ReturnType<typeof vi.fn>;
  let apply: ReturnType<typeof vi.fn>;
  const key = 'qwen-managed-task-cancel:["tenant:actor","s1"]';
  function Probe() {
    current = useManagedTaskCancel(
      provider,
      'client',
      sessionId,
      snapshots,
      refresh,
      apply,
    );
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(<Probe />);
    });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    sessionId = 's1';
    snapshots = [];
    refresh = vi.fn();
    apply = vi.fn();
    root = createRoot(document.createElement('div'));
    provider = {
      storageKey: 'tenant:actor',
      tasks: {
        get: vi.fn().mockResolvedValue(task),
        cancel: {
          submit: vi.fn().mockResolvedValue(taskOperation),
          query: vi.fn().mockResolvedValue(taskOperation),
        },
      },
    } as unknown as ManagedAgentProvider;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('saves before sending, blocks duplicates and waits for physical settlement after command completion', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockImplementation(
      async (_sessionId, _taskId, options) => {
        expect(sessionStorage.getItem(key)).toContain(options.idempotencyKey);
        return taskOperation;
      },
    );
    await render();
    let run!: Promise<void>;
    await act(async () => {
      run = current.submit(task);
      void current.submit(task);
    });
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    expect(current.states[task.taskId].status).toBe('stopping');
    expect(current.pendingTaskIds).toEqual([task.taskId]);
    await advance(30_000);
    await run;
    expect(current.states[task.taskId]).toMatchObject({
      status: 'stopping',
      busy: false,
    });
    snapshots = [
      { ...task, state: 'completed', settledAt: 5, actionCapabilities: [] },
    ];
    await render();
    expect(current.pendingTaskIds).toEqual([]);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('submits for any task kind that advertises cancel and for none that does not', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue(taskOperation);
    await render();
    await act(async () => {
      void current.submit({ ...task, kind: 'background_shell' });
    });
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    await act(async () => {
      void current.submit({
        ...task,
        kind: 'automation_run',
        taskId: 'task_other',
        actionCapabilities: [],
      });
    });
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
  });

  it('replays a lost reply only on user request with the same key after remount', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValueOnce(
      new TypeError('network'),
    );
    await render();
    await act(async () => current.submit(task));
    const original = vi.mocked(provider.tasks!.cancel!.submit).mock.calls[0][2]
      .idempotencyKey;
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    vi.mocked(provider.tasks!.get).mockResolvedValue({
      ...task,
      state: 'cancelled',
      settledAt: 5,
    });
    await act(async () => current.resume(task.taskId));
    expect(
      vi.mocked(provider.tasks!.cancel!.submit).mock.calls[1][2].idempotencyKey,
    ).toBe(original);
    expect(current.pendingTaskIds).toEqual([]);
  });

  it('automatically queries saved operation IDs without another POST', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        [task.taskId]: {
          sessionId,
          taskId: task.taskId,
          idempotencyKey: 'original',
          operationId: 'op1',
        },
      }),
    );
    vi.mocked(provider.tasks!.get).mockResolvedValue({
      ...task,
      state: 'cancelled',
      settledAt: 5,
    });
    await render();
    expect(provider.tasks!.cancel!.submit).not.toHaveBeenCalled();
    expect(provider.tasks!.cancel!.query).toHaveBeenCalledWith(
      's1',
      task.taskId,
      'op1',
      expect.objectContaining({ clientId: 'client' }),
    );
    expect(current.pendingTaskIds).toEqual([]);
  });

  it('follows a saved cancel of a task of any kind to its settlement', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        [task.taskId]: {
          sessionId,
          taskId: task.taskId,
          idempotencyKey: 'original',
          operationId: 'op1',
        },
      }),
    );
    vi.mocked(provider.tasks!.get).mockResolvedValue({
      ...task,
      kind: 'background_shell',
      state: 'cancelled',
      settledAt: 5,
    });
    await render();
    expect(provider.tasks!.cancel!.submit).not.toHaveBeenCalled();
    expect(current.pendingTaskIds).toEqual([]);
  });

  it('keeps pending timeout, blocked recovery, and revoked replay permission uncertain', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue({
      ...taskOperation,
      status: 'pending',
    });
    vi.mocked(provider.tasks!.cancel!.query).mockResolvedValue({
      ...taskOperation,
      status: 'pending',
    });
    await render();
    let run!: Promise<void>;
    await act(async () => {
      run = current.submit(task);
    });
    await advance(30_000);
    await run;
    expect(current.states[task.taskId].status).toBe('unconfirmed');
    vi.mocked(provider.tasks!.cancel!.query).mockResolvedValue({
      ...taskOperation,
      status: 'recovery_blocked',
      failureCode: 'task_cancel_unconfirmed',
    });
    await act(async () => current.resume(task.taskId));
    expect(current.states[task.taskId].status).toBe('unconfirmed');
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    const queries = vi.mocked(provider.tasks!.cancel!.query).mock.calls.length;
    await advance(3_000);
    expect(provider.tasks!.cancel!.query).toHaveBeenCalledTimes(queries);
    vi.mocked(provider.tasks!.cancel!.query).mockRejectedValue(
      new JavaManagedAgentHttpError(403, 'task_forbidden', 'denied'),
    );
    await act(async () => current.resume(task.taskId));
    expect(current.pendingTaskIds).toEqual([task.taskId]);
    expect(current.states[task.taskId].code).toBe('task_forbidden');
  });

  it('distinguishes a fresh admission refusal from a replay refusal', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValueOnce(
      new JavaManagedAgentHttpError(409, 'session_operation_active', 'busy'),
    );
    await render();
    await act(async () => current.submit(task));
    expect(current.pendingTaskIds).toEqual([]);
    expect(current.states[task.taskId].status).toBe('failed');
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValueOnce(
      new TypeError('lost'),
    );
    await act(async () => current.submit(task));
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValueOnce(
      new JavaManagedAgentHttpError(403, 'task_forbidden', 'denied'),
    );
    await act(async () => current.resume(task.taskId));
    expect(current.pendingTaskIds).toEqual([task.taskId]);
    expect(current.states[task.taskId].status).toBe('unconfirmed');
  });

  it('sends nothing when initial storage is unavailable', async () => {
    await render();
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    });
    await act(async () => current.submit(task));
    expect(provider.tasks!.cancel!.submit).not.toHaveBeenCalled();
    expect(current.states[task.taskId].code).toBe('storage_unavailable');
  });

  it('publishes terminal snapshots before clearing accepted recovery', async () => {
    const settled = {
      ...task,
      state: 'completed' as const,
      settledAt: 5,
      actionCapabilities: [],
    };
    vi.mocked(provider.tasks!.get).mockResolvedValue(settled);
    apply.mockImplementation(() =>
      expect(
        JSON.parse(sessionStorage.getItem(key)!)[task.taskId].accepted,
      ).toBe(true),
    );
    await render();
    await act(async () => current.submit(task));
    expect(apply).toHaveBeenCalledWith(settled);
    expect(current.pendingTaskIds).toEqual([]);
  });

  it('removes stale admission contention after terminal state without hiding other command failures', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValue(
      new JavaManagedAgentHttpError(409, 'session_operation_active', 'busy'),
    );
    await render();
    await act(async () => current.submit(task));
    expect(current.states[task.taskId].code).toBe('session_operation_active');
    expect(refresh).toHaveBeenCalledOnce();
    snapshots = [
      { ...task, state: 'cancelled', settledAt: 5, actionCapabilities: [] },
    ];
    await render();
    expect(current.states).toEqual({});
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue({
      ...taskOperation,
      status: 'failed',
      failureCode: 'runtime_unavailable',
    });
    await act(async () => current.submit(task));
    snapshots = [...snapshots];
    await render();
    expect(current.states[task.taskId].code).toBe('runtime_unavailable');
  });

  it('keeps an unknown command even if the task already ended', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockRejectedValue(
      new TypeError('lost'),
    );
    await render();
    await act(async () => current.submit(task));
    snapshots = [{ ...task, state: 'cancelled', settledAt: 5 }];
    await render();
    expect(current.pendingTaskIds).toEqual([task.taskId]);
    expect(current.states[task.taskId].status).toBe('unconfirmed');
  });

  it('ignores late responses after Session or account changes', async () => {
    let release!: (operation: ManagedTaskCancelOperation) => void;
    vi.mocked(provider.tasks!.cancel!.submit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    let run!: Promise<void>;
    await act(async () => {
      run = current.submit(task);
    });
    sessionId = 's2';
    provider = { ...provider, storageKey: 'tenant:other' };
    await render();
    await act(async () => {
      release(taskOperation);
      await run;
    });
    expect(current.pendingTaskIds).toEqual([]);
    expect(current.states).toEqual({});
    expect(sessionStorage.getItem(key)).toContain('idempotencyKey');
    expect(provider.tasks!.get).not.toHaveBeenCalled();
  });

  it('preserves confirmed stop acceptance across reload and a failed subsequent query', async () => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        [task.taskId]: {
          sessionId,
          taskId: task.taskId,
          idempotencyKey: 'original',
          operationId: 'op1',
          accepted: true,
        },
      }),
    );
    vi.mocked(provider.tasks!.cancel!.query).mockRejectedValue(
      new TypeError('offline'),
    );
    await render();
    expect(current.states[task.taskId]).toMatchObject({
      status: 'stopping',
      busy: false,
    });
    expect(current.pendingTaskIds).toEqual([task.taskId]);
    expect(provider.tasks!.cancel!.submit).not.toHaveBeenCalled();
  });

  it('retains the original request when storing the operation ID fails', async () => {
    const storage = sessionStorage;
    let writes = 0;
    vi.stubGlobal('sessionStorage', {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: (name: string, value: string) => {
        if (++writes > 1) throw new Error('quota');
        storage.setItem(name, value);
      },
    });
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue({
      ...taskOperation,
      status: 'pending',
    });
    vi.mocked(provider.tasks!.cancel!.query).mockRejectedValue(
      new TypeError('offline'),
    );
    await render();
    let run!: Promise<void>;
    await act(async () => {
      run = current.submit(task);
    });
    await advance(1000);
    await run;
    const keyUsed = vi.mocked(provider.tasks!.cancel!.submit).mock.calls[0][2]
      .idempotencyKey;
    expect(JSON.parse(storage.getItem(key)!)[task.taskId]).toEqual({
      sessionId,
      taskId: task.taskId,
      idempotencyKey: keyUsed,
    });
    vi.unstubAllGlobals();
    await act(async () => root.unmount());
    root = createRoot(document.createElement('div'));
    await render();
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue({
      ...taskOperation,
      status: 'recovery_blocked',
    });
    await act(async () => current.resume(task.taskId));
    expect(
      vi.mocked(provider.tasks!.cancel!.submit).mock.calls[1][2].idempotencyKey,
    ).toBe(keyUsed);
  });

  it('clears definitive operation failure and requires a user to create a fresh key', async () => {
    vi.mocked(provider.tasks!.cancel!.submit).mockResolvedValue({
      ...taskOperation,
      status: 'failed',
      failureCode: 'task_already_settled',
    });
    await render();
    await act(async () => current.submit(task));
    expect(current.pendingTaskIds).toEqual([]);
    expect(current.states[task.taskId].code).toBe('task_already_settled');
    expect(refresh).toHaveBeenCalled();
    expect(provider.tasks!.cancel!.submit).toHaveBeenCalledTimes(1);
    await act(async () => current.submit(task));
    const calls = vi.mocked(provider.tasks!.cancel!.submit).mock.calls;
    expect(calls[0][2].idempotencyKey).not.toBe(calls[1][2].idempotencyKey);
  });
});

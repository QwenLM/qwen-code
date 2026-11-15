// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedTask,
  ManagedTaskPage,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { task, taskEvent } from './managed-task.test-fixtures';
import { useManagedTasks } from './use-managed-tasks';

describe('useManagedTasks', () => {
  let root: Root;
  let provider: ManagedAgentProvider;
  let current: ReturnType<typeof useManagedTasks>;
  let sessionId: string;
  let open: boolean;
  function Probe() {
    current = useManagedTasks(provider, 'client', sessionId, open);
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(<Probe />);
    });
  const advance = (ms = 3_000) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  beforeEach(() => {
    vi.useFakeTimers();
    root = createRoot(document.createElement('div'));
    sessionId = 's1';
    open = true;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    provider = {
      storageKey: 'tenant:actor',
      tasks: {
        list: vi.fn().mockResolvedValue({ data: [task], hasMore: false }),
        get: vi.fn().mockResolvedValue(task),
        listEvents: vi
          .fn()
          .mockResolvedValue({ data: [], nextCursor: 'floor', hasMore: false }),
      },
    } as unknown as ManagedAgentProvider;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reads raw pages without scanning, retains cursors and pauses when closed or hidden', async () => {
    vi.mocked(provider.tasks!.list).mockResolvedValueOnce({
      data: [{ ...task, kind: 'automation_run' }],
      hasMore: true,
      nextCursor: 'older',
    });
    await render();
    expect(provider.tasks!.list).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 50 }),
    );
    expect(current.page.hasMore).toBe(true);
    await act(async () => current.next());
    expect(provider.tasks!.list).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ cursor: 'older' }),
    );
    expect(current.hasPrevious).toBe(true);
    await act(async () => current.previous());
    expect(provider.tasks!.list).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ cursor: undefined }),
    );
    open = false;
    await render();
    const calls = vi.mocked(provider.tasks!.list).mock.calls.length;
    await advance(9_000);
    expect(provider.tasks!.list).toHaveBeenCalledTimes(calls);
    open = true;
    await render();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    const hiddenCalls = vi.mocked(provider.tasks!.list).mock.calls.length;
    await advance(9_000);
    expect(provider.tasks!.list).toHaveBeenCalledTimes(hiddenCalls);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    expect(provider.tasks!.list).toHaveBeenCalledTimes(hiddenCalls + 1);
  });

  it('keeps cached reads interactive during background polling and announces explicit refreshes', async () => {
    vi.mocked(provider.tasks!.list).mockImplementation(
      () => new Promise(() => {}),
    );
    await render();
    expect(current.loading).toBe(true);
    vi.mocked(provider.tasks!.list).mockResolvedValueOnce({
      data: [task],
      hasMore: true,
      nextCursor: 'next',
    });
    await act(async () => current.refresh());
    expect(current.loading).toBe(false);
    expect(current.page.data).toEqual([task]);
    await advance();
    expect(current.loading).toBe(false);
    expect(current.page.hasMore).toBe(true);
    expect(current.page.data).toEqual([task]);
    await act(async () => current.refresh());
    expect(current.loading).toBe(true);
  });

  it('publishes a cancellation snapshot and rejects late regressions and old-owner writes', async () => {
    let release!: (page: ManagedTaskPage) => void;
    await render();
    await act(async () => current.select(task.taskId));
    const settled: ManagedTask = {
      ...task,
      state: 'cancelled',
      settledAt: 5,
      actionCapabilities: [],
    };
    const apply = current.apply;
    vi.mocked(provider.tasks!.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await advance();
    await act(async () => apply(settled));
    expect(current.task).toEqual(settled);
    await act(async () => release({ data: [task], hasMore: false }));
    expect(current.page.data[0]).toEqual(settled);
    expect(current.task).toEqual(settled);
    await act(async () => current.select());
    await act(async () => current.select(task.taskId));
    expect(current.task).toEqual(settled);
    sessionId = 's2';
    vi.mocked(provider.tasks!.list).mockResolvedValue({
      data: [{ ...task, sessionId }],
      hasMore: false,
    });
    await render();
    await act(async () => apply(settled));
    expect(current.page.data[0].sessionId).toBe('s2');
    expect(current.page.data[0].state).toBe('running');
  });

  it('uses the event page checkpoint, deduplicates and resets an expired cursor', async () => {
    vi.mocked(provider.tasks!.get).mockResolvedValue({
      ...task,
      outputCursor: 'tail-to-avoid',
    });
    vi.mocked(provider.tasks!.listEvents)
      .mockResolvedValueOnce({
        data: [taskEvent('e1'), taskEvent('e2', 'future_event')],
        nextCursor: 'e2',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        data: [taskEvent('e2', 'future_event'), taskEvent('e3')],
        nextCursor: 'e3',
        hasMore: false,
      })
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(409, 'cursor_expired', 'expired'),
      )
      .mockResolvedValue({
        data: [taskEvent('e4')],
        nextCursor: 'e4',
        hasMore: false,
      });
    await render();
    await act(async () => current.select(task.taskId));
    expect(provider.tasks!.listEvents).toHaveBeenLastCalledWith(
      's1',
      task.taskId,
      expect.objectContaining({ after: undefined }),
    );
    await advance();
    expect(provider.tasks!.listEvents).toHaveBeenCalledTimes(1);
    await act(async () => current.loadMoreEvents());
    expect(provider.tasks!.listEvents).toHaveBeenLastCalledWith(
      's1',
      task.taskId,
      expect.objectContaining({ after: 'e2' }),
    );
    expect(current.events.map((event) => event.cursor)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    await advance();
    expect(current.historyGap).toBe(true);
    expect(current.events).toEqual([]);
    await advance();
    expect(provider.tasks!.listEvents).toHaveBeenLastCalledWith(
      's1',
      task.taskId,
      expect.objectContaining({ after: undefined }),
    );
    expect(current.events.map((event) => event.cursor)).toEqual(['e4']);
  });

  it('serializes polls and ignores old page and Session responses even when abort is ignored', async () => {
    let release!: (page: ManagedTaskPage) => void;
    vi.mocked(provider.tasks!.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render();
    await advance(9_000);
    expect(provider.tasks!.list).toHaveBeenCalledTimes(1);
    sessionId = 's2';
    vi.mocked(provider.tasks!.list).mockResolvedValue({
      data: [{ ...task, sessionId: 's2', taskId: 'task_new' }],
      hasMore: false,
    });
    await render();
    await act(async () => release({ data: [task], hasMore: false }));
    expect(current.page.data[0].taskId).toBe('task_new');
    expect(current.events).toEqual([]);
  });

  it('invalidates old detail reads in the same batch as selecting another task', async () => {
    let oldReply!: (value: typeof task) => void;
    let newReply!: (value: typeof task) => void;
    vi.mocked(provider.tasks!.get)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldReply = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newReply = resolve;
          }),
      );
    await render();
    await act(async () => current.select(task.taskId));
    await act(async () => {
      current.select('task_new');
      oldReply(task);
      await Promise.resolve();
    });
    expect(current.selectedId).toBe('task_new');
    expect(current.task).toBeUndefined();
    const next = { ...task, taskId: 'task_new' };
    vi.mocked(provider.tasks!.listEvents).mockResolvedValue({
      data: [],
      hasMore: false,
      nextCursor: 'floor-new',
    });
    await act(async () => newReply(next));
    expect(current.task?.taskId).toBe('task_new');
  });

  it('reads and applies a task of any kind', async () => {
    const workflow = { ...task, kind: 'workflow' as const };
    vi.mocked(provider.tasks!.list).mockResolvedValue({
      data: [workflow],
      hasMore: false,
    });
    vi.mocked(provider.tasks!.get).mockResolvedValue(workflow);
    await render();
    await act(async () => current.select(workflow.taskId));
    expect(current.error).toBeUndefined();
    expect(current.task?.kind).toBe('workflow');
    await act(async () =>
      current.apply({ ...workflow, state: 'cancelled', settledAt: 5 }),
    );
    expect(current.page.data[0].state).toBe('cancelled');
  });

  it('does not let event state override the authoritative task snapshot', async () => {
    vi.mocked(provider.tasks!.get).mockResolvedValue({
      ...task,
      state: 'completed',
      settledAt: 4,
    });
    vi.mocked(provider.tasks!.listEvents).mockResolvedValue({
      data: [taskEvent('old')],
      nextCursor: 'old',
      hasMore: false,
    });
    await render();
    await act(async () => current.select(task.taskId));
    expect(current.task?.state).toBe('completed');
    expect(current.page.data[0].state).toBe('completed');
    expect(current.events[0].state).toBe('running');
  });
});

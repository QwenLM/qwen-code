// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { waitFor } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useManagedSessionLifecycle } from './use-managed-session-lifecycle';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedLifecycleOperation,
} from './managed-agent-provider';
const roots = new Set<Root>();
async function renderHook<T, P>(
  use: (props: P) => T,
  options?: { initialProps: P },
) {
  const result = { current: undefined as T };
  let props = options?.initialProps;
  function Hook() {
    result.current = use(props!);
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  const render = () =>
    act(async () => {
      root.render(
        <StrictMode>
          <Hook />
        </StrictMode>,
      );
    });
  await render();
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      roots.delete(root);
      host.remove();
    },
    rerender: (next: P) => {
      props = next;
      return render();
    },
  };
}
afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const summary = {
  sessionId: 's',
  title: 'Session',
  lifecycleStatus: 'active',
  capabilities: { sessionClose: true },
  workspace: { workspaceId: 'ws' },
} as ManagedAgentSessionSummary;
const operation = (
  status: string,
  type = 'close',
  id = 'op',
): ManagedLifecycleOperation => ({
  operationId: id,
  sessionId: 's',
  type,
  status,
  admissionStage: 'java_durable',
  deliveryState: 'pending',
  replayed: false,
});
function fixture() {
  const api = {
    submit: vi
      .fn<NonNullable<ManagedAgentProvider['lifecycle']>['submit']>()
      .mockResolvedValue(operation('completed')),
    query: vi.fn<NonNullable<ManagedAgentProvider['lifecycle']>['query']>(),
    unarchive:
      vi.fn<NonNullable<ManagedAgentProvider['lifecycle']>['unarchive']>(),
  };
  const provider = {
    storageKey: 'actor-a',
    lifecycle: api,
  } as unknown as ManagedAgentProvider;
  const changed = vi.fn();
  return { api, provider, changed };
}
beforeEach(() => {
  sessionStorage.clear();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
it('closes then archives with separate persisted keys and navigates only after completion', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockImplementation(async (kind: string) =>
    operation('completed', kind, kind),
  );
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close_archive');
  });
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith('s', 'close_archive', 'ws'),
  );
  expect(api.submit.mock.calls.map((call) => call[0])).toEqual([
    'close',
    'archive',
  ]);
  const keys = api.submit.mock.calls.map((call) => call[2].idempotencyKey);
  expect(keys[0]).not.toBe(keys[1]);
  expect(sessionStorage.length).toBe(0);
});
it('replays an unknown response with the same key across refresh', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockRejectedValueOnce(new Error('response lost'));
  const first = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    first.result.current.start(summary, 'delete');
  });
  await waitFor(() =>
    expect(first.result.current.states.s?.status).toBe('unconfirmed'),
  );
  const key = api.submit.mock.calls[0]![2].idempotencyKey;
  first.unmount();
  api.submit.mockResolvedValue(operation('completed', 'delete'));
  const second = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith('s', 'delete', 'ws'),
  );
  expect(api.submit.mock.calls[1]![2].idempotencyKey).toBe(key);
  second.unmount();
});
it('accepts an unarchive replay after another browser archived the session again', async () => {
  const { api, provider, changed } = fixture();
  api.unarchive.mockRejectedValueOnce(new Error('response lost'));
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'unarchive');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.status).toBe('unconfirmed'),
  );
  const key = api.unarchive.mock.calls[0]![1].idempotencyKey;
  api.unarchive.mockResolvedValue({ ...summary, lifecycleStatus: 'archived' });
  await act(async () => {
    hook.result.current.confirm('s');
  });
  expect(api.unarchive.mock.calls[1]![1].idempotencyKey).toBe(key);
  expect(changed).toHaveBeenCalledWith('s', 'unarchive', 'ws');
  expect(hook.result.current.blocked('s')).toBe(false);
});
it('requires an explicit new key after a failed operation', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockResolvedValueOnce(operation('failed'));
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.status).toBe('failed'),
  );
  expect(api.submit).toHaveBeenCalledTimes(1);
  const key = api.submit.mock.calls[0]![2].idempotencyKey;
  await act(async () => {
    hook.result.current.confirm('s');
  });
  await waitFor(() => expect(changed).toHaveBeenCalledWith('s', 'close', 'ws'));
  expect(api.submit.mock.calls[1]![2].idempotencyKey).not.toBe(key);
});
it('never submits a retry key that could not be persisted', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockResolvedValueOnce(operation('failed'));
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.status).toBe('failed'),
  );
  const storage = vi
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation(() => {
      throw new Error('quota exhausted');
    });
  await act(async () => hook.result.current.confirm('s'));
  await act(async () => hook.result.current.confirm('s'));
  expect(api.submit).toHaveBeenCalledTimes(1);
  expect(hook.result.current.states.s?.code).toBe('storage_unavailable');
  storage.mockRestore();
  await act(async () => hook.result.current.confirm('s'));
  expect(api.submit).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledWith('s', 'close', 'ws');
});
it('does not redeliver recovery-blocked operations', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockResolvedValue(operation('recovery_blocked'));
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.status).toBe('recovery_blocked'),
  );
  expect(hook.result.current.blocked('s')).toBe(true);
  expect(api.submit).toHaveBeenCalledTimes(1);
  hook.unmount();
});
it('keeps observing a healthy operation that takes longer than 30 seconds', async () => {
  vi.useFakeTimers();
  const { api, provider, changed } = fixture();
  api.submit.mockResolvedValue(operation('pending'));
  api.query.mockResolvedValue(operation('running'));
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(31_000);
  });
  expect(hook.result.current.states.s?.status).toBe('running');
  expect(hook.result.current.states.s?.busy).toBe(true);
  expect(api.submit).toHaveBeenCalledTimes(1);
  api.query.mockResolvedValue(operation('completed'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(changed).toHaveBeenCalledWith('s', 'close', 'ws');
});
it('recovers a server operation after the original browser is gone', async () => {
  const { api, provider, changed } = fixture();
  api.query.mockResolvedValue(operation('completed'));
  const observed = {
    ...summary,
    lifecycleStatus: 'closing',
    lifecycleOperation: {
      operationId: 'op',
      type: 'close' as const,
      status: 'running' as const,
    },
  };
  await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [observed], changed),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledWith('s', 'close', 'ws'));
  expect(api.submit).not.toHaveBeenCalled();
  expect(api.query).toHaveBeenCalledWith('s', 'op', expect.anything());
});
it('keeps an unfinished archive recoverable after close succeeds', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockImplementation(async (kind: string) => {
    if (kind === 'archive') throw new Error('response lost');
    return operation('completed');
  });
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close_archive');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.status).toBe('unconfirmed'),
  );
  const key = api.submit.mock.calls[1]![2].idempotencyKey;
  api.submit.mockResolvedValue(operation('completed', 'archive', 'archive'));
  await act(async () => {
    hook.result.current.confirm('s');
  });
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith('s', 'close_archive', 'ws'),
  );
  expect(api.submit.mock.calls[2]![0]).toBe('archive');
  expect(api.submit.mock.calls[2]![2].idempotencyKey).toBe(key);
});
it('restores a refused archive without resubmitting until an explicit retry', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockImplementation(async (kind: string) => {
    if (kind === 'archive')
      throw new JavaManagedAgentHttpError(
        409,
        'workspace_lifecycle_refused',
        'refused',
      );
    return operation('completed');
  });
  const first = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => first.result.current.start(summary, 'close_archive'));
  await waitFor(() =>
    expect(first.result.current.states.s?.status).toBe('failed'),
  );
  const key = api.submit.mock.calls[1]![2].idempotencyKey;
  expect(api.submit).toHaveBeenCalledTimes(2);
  first.unmount();

  api.submit.mockResolvedValue(operation('completed', 'archive', 'archive'));
  const second = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  expect(api.submit).toHaveBeenCalledTimes(2);
  expect(second.result.current.states.s).toMatchObject({
    action: 'close_archive',
    status: 'failed',
    busy: false,
    canConfirm: true,
    kind: 'archive',
  });
  expect(second.result.current.blocked('s')).toBe(true);
  await act(async () => second.result.current.confirm('s'));
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith('s', 'close_archive', 'ws'),
  );
  expect(api.submit).toHaveBeenCalledTimes(3);
  expect(api.submit.mock.calls[2]![0]).toBe('archive');
  expect(api.submit.mock.calls[2]![2].idempotencyKey).not.toBe(key);
});
it('releases definite turn_active admission refusals and leaves task cancellation explicit', async () => {
  const { api, provider, changed } = fixture();
  api.submit.mockRejectedValue(
    new JavaManagedAgentHttpError(409, 'turn_active', 'busy'),
  );
  const hook = await renderHook(() =>
    useManagedSessionLifecycle(provider, 'c', [], changed),
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await waitFor(() =>
    expect(hook.result.current.states.s?.code).toBe('turn_active'),
  );
  expect(hook.result.current.blocked('s')).toBe(false);
  expect(hook.result.current.states.s?.canConfirm).toBe(false);
});
it('does not apply a completion from an old identity', async () => {
  const { api, provider, changed } = fixture();
  let finish!: (value: ManagedLifecycleOperation) => void;
  api.submit.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = await renderHook(
    ({ p }) => useManagedSessionLifecycle(p, 'c', [], changed),
    { initialProps: { p: provider } },
  );
  await act(async () => {
    hook.result.current.start(summary, 'close');
  });
  await hook.rerender({ p: { ...provider, storageKey: 'actor-b' } });
  await act(async () => {
    finish(operation('completed'));
  });
  expect(changed).not.toHaveBeenCalled();
});

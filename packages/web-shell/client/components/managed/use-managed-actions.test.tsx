// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';
import { useManagedActions } from './use-managed-actions';

const pending: ManagedAgentPendingAction = {
  actionId: 'tool_approval_1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  functionCallId: 'call-1',
  toolName: 'write_file',
  inputRevision: 1,
  policyRevision: 'hosted-tool-approval/1',
  expiresAt: Date.now() + 600_000,
  options: [
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' },
  ],
};

function update(id: number): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type: 'action_updated',
    sessionId: 'session-1',
    turnId: '',
    data: { actionId: 'tool_approval_1', state: 'requested' },
  };
}

describe('useManagedActions', () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.useRealTimers();
  });

  function mount(
    provider: ManagedAgentProvider,
    initial: {
      enabled: boolean;
      events: ManagedAgentSessionEvent[];
    },
  ) {
    let latest: ReturnType<typeof useManagedActions> | undefined;
    let props = initial;
    function Probe(current: typeof initial) {
      latest = useManagedActions(
        provider,
        'session-1',
        'client-1',
        current.enabled,
        current.events,
      );
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<Probe {...props} />));
    return {
      get latest() {
        return latest;
      },
      rerender(next: Partial<typeof initial>) {
        props = { ...props, ...next };
        act(() => root!.render(<Probe {...props} />));
      },
    };
  }

  it('reads nothing when the Session cannot serve Actions', () => {
    const listPending = vi.fn();
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: false, events: [] });
    expect(listPending).not.toHaveBeenCalled();
    expect(hook.latest?.action).toBeUndefined();
  });

  it('re-reads pending approvals when the stream reports a change', async () => {
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pending]);
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(1));
    expect(hook.latest?.action).toBeUndefined();

    hook.rerender({ events: [update(7)] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it('hides an answered approval and brings it back if the answer fails', async () => {
    const respond = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(() => hook.latest!.respond('tool_approval_1', 'deny'));
    expect(hook.latest?.action).toEqual(pending);
    expect(hook.latest?.answerError).toEqual(new Error('offline'));
    expect(hook.latest?.loadError).toBeUndefined();

    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    expect(respond).toHaveBeenLastCalledWith(pending, 'allow', {
      clientId: 'client-1',
      idempotencyKey: 'tool_approval_1:allow',
    });
    await vi.waitFor(() => expect(hook.latest?.action).toBeUndefined());
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it('retries a failed read so a transient failure does not hide an approval', async () => {
    vi.useFakeTimers();
    const listPending = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([pending]);
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.latest?.loadError).toEqual(new Error('unavailable'));
    expect(hook.latest?.answerError).toBeUndefined();
    expect(hook.latest?.action).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(listPending).toHaveBeenCalledTimes(2);
    expect(hook.latest?.action).toEqual(pending);
    expect(hook.latest?.loadError).toBeUndefined();
  });

  it('stops retrying after a bound and reads again on demand', async () => {
    vi.useFakeTimers();
    const listPending = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([pending]);
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // The first read and three retries; no fifth read without a request.
    expect(listPending).toHaveBeenCalledTimes(4);
    expect(hook.latest?.loadError).toEqual(new Error('unavailable'));

    await act(async () => {
      hook.latest!.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listPending).toHaveBeenCalledTimes(5);
    expect(hook.latest?.action).toEqual(pending);
    expect(hook.latest?.loadError).toBeUndefined();
  });
});

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
} from './managed-agent-provider';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
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

function gap(id: number): ManagedAgentSessionEvent {
  return { id, at: id, type: 'stream_gap', sessionId: 'session-1', turnId: '' };
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
      enabled: boolean | undefined;
      events: ManagedAgentSessionEvent[];
      sessionId?: string;
    },
  ) {
    let latest: ReturnType<typeof useManagedActions> | undefined;
    let props = initial;
    function Probe(current: typeof initial) {
      latest = useManagedActions(
        provider,
        current.sessionId ?? 'session-1',
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
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(async () => {
      await expect(
        hook.latest!.respond('tool_approval_1', 'deny'),
      ).rejects.toThrow('offline');
    });
    expect(hook.latest?.action).toEqual(pending);
    expect(hook.latest?.answerError).toEqual(new Error('offline'));
    expect(hook.latest?.loadError).toBeUndefined();

    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    expect(respond).toHaveBeenLastCalledWith(pending, 'allow', {
      clientId: 'client-1',
      idempotencyKey: 'tool_approval_1:allow',
    });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    expect(hook.latest?.action).toBeUndefined();
    hook.rerender({ events: [update(8)] });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(3));
    expect(hook.latest?.action).toBeUndefined();
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
    for (const delay of [0, 2_000, 5_000, 10_000, 60_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
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

  it('drops the unconfirmed-answer warning once that Action leaves the list', async () => {
    const respond = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(async () => {
      await expect(
        hook.latest!.respond('tool_approval_1', 'allow'),
      ).rejects.toThrow('offline');
    });
    expect(hook.latest?.answerError).toEqual(new Error('offline'));

    // The Action is still pending, so the warning is still about something.
    hook.rerender({ events: [update(7)] });
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    expect(hook.latest?.answerError).toEqual(new Error('offline'));

    // The Harness ended it: there is no card left to retry.
    hook.rerender({ events: [update(8)] });
    await vi.waitFor(() => expect(hook.latest?.action).toBeUndefined());
    expect(listPending).toHaveBeenCalledTimes(3);
    expect(hook.latest?.answerError).toBeUndefined();
  });

  it('restores the retry budget when the reader is withdrawn and back', async () => {
    vi.useFakeTimers();
    const listPending = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce([pending]);
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    for (const delay of [0, 2_000, 5_000, 10_000, 60_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    // The first read and three retries; the ladder is exhausted.
    expect(listPending).toHaveBeenCalledTimes(4);

    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(listPending).toHaveBeenCalledTimes(5);
    // The restored read failed, and it is retried instead of being stranded.
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(listPending).toHaveBeenCalledTimes(6);
    expect(hook.latest?.action).toEqual(pending);
    expect(hook.latest?.loadError).toBeUndefined();
  });

  it('keeps the shown approval while the capability is unknown', async () => {
    const listPending = vi.fn().mockResolvedValue([pending]);
    const respond = vi.fn().mockResolvedValue(undefined);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    hook.rerender({ enabled: undefined });
    expect(hook.latest?.action).toEqual(pending);
    expect(listPending).toHaveBeenCalledTimes(1);

    hook.rerender({ enabled: false });
    expect(hook.latest?.action).toBeUndefined();
    expect(listPending).toHaveBeenCalledTimes(1);

    // An answer given while the capability is unknown still reaches the
    // service, and the list is read once the capability is known again.
    hook.rerender({ enabled: true });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    hook.rerender({ enabled: undefined });
    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it.each([5_000, -5_000])(
    're-reads once for an expiry %i ms from the browser clock',
    async (delay) => {
      vi.useFakeTimers();
      const action = { ...pending, expiresAt: Date.now() + delay };
      const listPending = vi
        .fn()
        .mockImplementation(async () => [{ ...action }]);
      const provider = {
        actions: { listPending, respond: vi.fn() },
      } as unknown as ManagedAgentProvider;
      const hook = mount(provider, { enabled: true, events: [] });
      await act(async () => Promise.resolve());
      await act(async () =>
        vi.advanceTimersByTimeAsync(Math.max(0, delay) + 1_000),
      );
      expect(listPending).toHaveBeenCalledTimes(2);
      expect(hook.latest?.action).toEqual(action);
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(listPending).toHaveBeenCalledTimes(2);
    },
  );

  it('re-reads pending approvals when the transcript reports a stream gap', async () => {
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

    // A gap arrives through the durable transcript: the live stream is broken
    // on before merging, so the snapshot's `stream.reconciled` row is the only
    // thing that reports one here.
    hook.rerender({ events: [gap(7)] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it('drops the previous Session card and its warnings when the selection changes', async () => {
    const respond = vi.fn().mockRejectedValue(new Error('offline'));
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      // The new Session's read never returns, so nothing but the switch itself
      // can clear what the previous Session left behind.
      .mockImplementation(() => new Promise(() => {}));
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(async () => {
      await expect(
        hook.latest!.respond('tool_approval_1', 'allow'),
      ).rejects.toThrow('offline');
    });
    expect(hook.latest?.answerError).toEqual(new Error('offline'));

    hook.rerender({ sessionId: 'session-2' });
    expect(hook.latest?.action).toBeUndefined();
    expect(hook.latest?.answerError).toBeUndefined();
    expect(hook.latest?.loadError).toBeUndefined();
    expect(hook.latest?.loaded).toBe(false);
    expect(listPending).toHaveBeenCalledTimes(2);
    // The previous Session's Action is not answerable from the new one.
    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('reports whether the read landed so a failure can name what it broke', async () => {
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockRejectedValueOnce(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      );
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.loaded).toBe(true));
    expect(hook.latest?.loadError).toBeUndefined();

    hook.rerender({ events: [update(7)] });
    await vi.waitFor(() => expect(hook.latest?.loadError).toBeDefined());
    // The card that was loaded is still the one on screen.
    expect(hook.latest?.loaded).toBe(true);
    expect(hook.latest?.action).toEqual(pending);
  });

  it('does not retry a read the service answered definitively', async () => {
    vi.useFakeTimers();
    const listPending = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(404, 'session_not_found', 'Not found'),
      );
    const provider = {
      actions: { listPending, respond: vi.fn() },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(hook.latest?.loadError).toBeInstanceOf(JavaManagedAgentHttpError);

    for (const delay of [2_000, 5_000, 10_000, 60_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    // A deleted Session answers the same way forever, so the ladder would only
    // spend four guaranteed-failing requests; the user's own retry is the only
    // thing that starts another.
    expect(listPending).toHaveBeenCalledTimes(1);

    await act(async () => {
      hook.latest!.retry();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listPending).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 503])(
    'still retries a %i read, which can be transient',
    async (status) => {
      vi.useFakeTimers();
      const listPending = vi
        .fn()
        .mockRejectedValue(
          new JavaManagedAgentHttpError(status, 'unavailable', 'Busy'),
        );
      const provider = {
        actions: { listPending, respond: vi.fn() },
      } as unknown as ManagedAgentProvider;
      const hook = mount(provider, { enabled: true, events: [] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(listPending).toHaveBeenCalledTimes(1);

      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(listPending).toHaveBeenCalledTimes(2);
      expect(hook.latest?.loadError).toBeDefined();
    },
  );
});

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

  it.each([
    ['Session switch', 'fails'],
    ['Session switch', 'succeeds'],
    ['Session switch', 'ends'],
    ['Action replacement', 'fails'],
    ['Action replacement', 'succeeds'],
    ['Action replacement', 'ends'],
  ])(
    'keeps the current warning after %s when an old answer %s',
    async (change, outcome) => {
      let resolveAnswer!: () => void;
      let rejectAnswer!: (failure: Error) => void;
      const respond = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              resolveAnswer = resolve;
              rejectAnswer = reject;
            }),
        )
        .mockRejectedValueOnce(new Error('current-offline'));
      const next = {
        ...pending,
        actionId: 'tool_approval_2',
        sessionId: change === 'Session switch' ? 'session-2' : 'session-1',
      };
      const listPending = vi
        .fn()
        .mockResolvedValueOnce([pending])
        .mockResolvedValue([next]);
      const provider = {
        actions: { listPending, respond },
      } as unknown as ManagedAgentProvider;
      const hook = mount(provider, { enabled: true, events: [] });
      await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

      let oldAnswer!: Promise<unknown>;
      await act(async () => {
        oldAnswer = hook
          .latest!.respond(pending.actionId, 'allow')
          .catch((failure: unknown) => failure);
      });
      hook.rerender(
        change === 'Session switch'
          ? { sessionId: next.sessionId }
          : { events: [update(7)] },
      );
      await vi.waitFor(() => expect(hook.latest?.action).toEqual(next));
      await act(async () => {
        await expect(
          hook.latest!.respond(next.actionId, 'allow'),
        ).rejects.toThrow('current-offline');
      });
      expect(hook.latest?.answerError).toEqual(new Error('current-offline'));

      await act(async () => {
        if (outcome === 'fails') rejectAnswer(new Error('old-offline'));
        else if (outcome === 'ends') {
          rejectAnswer(
            new JavaManagedAgentHttpError(409, 'action_expired', 'Expired'),
          );
        } else resolveAnswer();
        await oldAnswer;
      });
      expect(hook.latest?.action).toEqual(next);
      expect(hook.latest?.answerError).toEqual(new Error('current-offline'));
    },
  );

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

  it('keeps the creator-only refusal for the Session after that Action leaves the list', async () => {
    const next = { ...pending, actionId: 'tool_approval_2' };
    const respond = vi
      .fn()
      .mockRejectedValue(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([next]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    expect(hook.latest?.respondForbidden).toBe(false);

    await act(async () => {
      await expect(
        hook.latest!.respond('tool_approval_1', 'allow'),
      ).rejects.toThrow('Forbidden');
    });
    expect(hook.latest?.respondForbidden).toBe(true);

    // The refused Action is gone and its per-Action warning with it, but the
    // refusal is a fact about the viewer and the Session, so it still covers
    // the Action that replaced it.
    hook.rerender({ events: [update(7)] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(next));
    expect(hook.latest?.answerError).toBeUndefined();
    expect(hook.latest?.respondForbidden).toBe(true);

    // A different Session may be the viewer's own: the refusal does not
    // follow the selection.
    hook.rerender({ sessionId: 'session-2' });
    expect(hook.latest?.respondForbidden).toBe(false);

    // Coming back does not re-admit the 403 either: the refusal is remembered
    // for the Session, not for one uninterrupted visit to it.
    hook.rerender({ sessionId: 'session-1' });
    expect(hook.latest?.respondForbidden).toBe(true);
  });

  it('latches a creator-only refusal that lands after the Action left the list', async () => {
    let rejectAnswer!: (failure: Error) => void;
    const respond = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAnswer = reject;
        }),
    );
    const next = { ...pending, actionId: 'tool_approval_2' };
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([next]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    expect(hook.latest?.respondForbidden).toBe(false);

    let oldAnswer!: Promise<unknown>;
    await act(async () => {
      oldAnswer = hook
        .latest!.respond(pending.actionId, 'allow')
        .catch((failure: unknown) => failure);
    });

    // The refused Action leaves the pending list while its answer is in flight.
    // The service checks the creator before it checks that the Action still
    // exists, so the refusal arrives anyway and still has to latch: the next
    // approval of this Session is refused identically.
    hook.rerender({ events: [update(7)] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(next));
    await act(async () => {
      rejectAnswer(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
      await oldAnswer;
    });
    expect(hook.latest?.respondForbidden).toBe(true);
    // The warning is still scoped to the Action that failed, and that Action is
    // gone, so the latch is what carries the reason from here on.
    expect(hook.latest?.answerError).toBeUndefined();
  });

  it('latches the Session the answer was aimed at, not the one now selected', async () => {
    let rejectAnswer!: (failure: Error) => void;
    const respond = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAnswer = reject;
        }),
    );
    const listPending = vi.fn().mockResolvedValue([pending]);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    let refusedAnswer!: Promise<unknown>;
    await act(async () => {
      refusedAnswer = hook
        .latest!.respond(pending.actionId, 'allow')
        .catch((failure: unknown) => failure);
    });

    // The Session nav has no in-flight guard, so the viewer can already be
    // looking at their own Session when the 403 lands. Latching that one would
    // disable a card they may well be allowed to answer, while the Session that
    // actually refused keeps offering one guaranteed 403 per click.
    hook.rerender({ sessionId: 'session-2' });
    await act(async () => {
      rejectAnswer(
        new JavaManagedAgentHttpError(403, 'action_forbidden', 'Forbidden'),
      );
      await refusedAnswer;
    });
    expect(hook.latest?.respondForbidden).toBe(false);

    hook.rerender({ sessionId: 'session-1' });
    expect(hook.latest?.respondForbidden).toBe(true);
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

  it('restores the retry budget after a reload of the Session summary', async () => {
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
    expect(listPending).toHaveBeenCalledTimes(4);

    // Refresh reloads the summary: the capability is unknown, then known again.
    hook.rerender({ enabled: undefined });
    hook.rerender({ enabled: true });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(listPending).toHaveBeenCalledTimes(5);
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

  it('drops an approval the service reports as ended and reads again', async () => {
    const ended = Object.assign(new Error('Action expired'), {
      status: 409,
      code: 'action_expired',
    });
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([]);
    const respond = vi.fn().mockRejectedValue(ended);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    expect(hook.latest?.action).toBeUndefined();
    expect(hook.latest?.answerError).toBeUndefined();
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    expect(hook.latest?.action).toBeUndefined();
  });

  it('drops an approval another client already answered', async () => {
    // The code Java returns when a stale tab answers an Action that another
    // tab or the REST API already decided.
    const ended = Object.assign(new Error('Action already resolved'), {
      status: 409,
      code: 'action_already_resolved',
    });
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([]);
    const respond = vi.fn().mockRejectedValue(ended);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(() => hook.latest!.respond('tool_approval_1', 'deny'));
    expect(hook.latest?.action).toBeUndefined();
    expect(hook.latest?.answerError).toBeUndefined();
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
  });

  it('shows an ended approval again when the next read still lists it', async () => {
    const ended = Object.assign(new Error('Action cancelled'), {
      status: 409,
      code: 'action_cancelled',
    });
    const listPending = vi.fn().mockResolvedValue([pending]);
    const respond = vi.fn().mockRejectedValue(ended);
    const provider = {
      actions: { listPending, respond },
    } as unknown as ManagedAgentProvider;
    const hook = mount(provider, { enabled: true, events: [] });
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));

    await act(() => hook.latest!.respond('tool_approval_1', 'allow'));
    await vi.waitFor(() => expect(listPending).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hook.latest?.action).toEqual(pending));
    expect(hook.latest?.answerError).toBeUndefined();
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

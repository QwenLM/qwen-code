import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundOutputCoordinator,
  type BackgroundOutputCoordinatorOptions,
  type BackgroundOutputPacket,
  type BackgroundOutputTarget,
} from './background-output-coordinator.js';
import type { BackgroundResponseContext } from './ChannelAgentBridge.js';
import type { SessionTarget } from './types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function context(
  overrides: Partial<BackgroundResponseContext> = {},
): BackgroundResponseContext {
  return {
    kind: 'agent',
    taskId: 'task-1',
    turnId: 'turn-1',
    status: 'running',
    turnComplete: false,
    ...overrides,
  };
}

function fixture(overrides: Partial<BackgroundOutputCoordinatorOptions> = {}) {
  const target: SessionTarget = {
    channelName: 'test-channel',
    senderId: 'user-1',
    chatId: 'chat-1',
    isGroup: true,
  };
  const packets: BackgroundOutputPacket[] = [];
  const send = vi.fn(async (packet: BackgroundOutputPacket) => {
    packets.push({ ...packet });
    return { turnComplete: packet.turnComplete };
  });
  const options = {
    outputMode: 'per_turn' as const,
    getTarget: vi.fn(() => target),
    getSourceLabel: vi.fn(() => 'Named session'),
    resolveDelivery: vi.fn(async () => ({
      target,
      sourceLabel: 'Named session',
    })),
    createDelivery: vi.fn(() => send),
    isRetryableError: vi.fn(() => true),
    log: vi.fn(),
    ...overrides,
  };
  const coordinator = new BackgroundOutputCoordinator(options);
  return { coordinator, target, packets, send, options };
}

function expectIdle(coordinator: BackgroundOutputCoordinator) {
  const state = coordinator as unknown as {
    backgroundResponseAggregations: Map<string, unknown>;
    detachedBackgroundResponseAggregations: Set<unknown>;
    pendingBackgroundResponseTerminals: Map<string, unknown>;
    detachedPendingBackgroundResponseTerminals: Set<unknown>;
  };
  expect(state.backgroundResponseAggregations.size).toBe(0);
  expect(state.detachedBackgroundResponseAggregations.size).toBe(0);
  expect(state.pendingBackgroundResponseTerminals.size).toBe(0);
  expect(state.detachedPendingBackgroundResponseTerminals.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('BackgroundOutputCoordinator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([undefined, 'per_response'] as const)(
    'leaves output immediate for mode %s',
    async (outputMode) => {
      const { coordinator, options, packets } = fixture({ outputMode });
      await expect(
        coordinator.dispatch('session-1', 'Result', context()),
      ).resolves.toBe(false);
      expect(options.resolveDelivery).not.toHaveBeenCalled();
      expect(packets).toEqual([]);
    },
  );

  it('leaves output immediate when turn metadata is missing', async () => {
    const { coordinator, options } = fixture();
    await expect(coordinator.dispatch('session-1', 'Result')).resolves.toBe(
      false,
    );
    await expect(
      coordinator.dispatch(
        'session-1',
        'Result',
        context({ turnComplete: undefined }),
      ),
    ).resolves.toBe(false);
    expect(options.resolveDelivery).not.toHaveBeenCalled();
  });

  it.each(['agent', 'shell', 'monitor', 'workflow'] as const)(
    'selects the latest non-empty %s output and preserves attribution',
    async (kind) => {
      const { coordinator, packets, options, target } = fixture();
      await coordinator.dispatch(
        'session-1',
        'Earlier output',
        context({ kind }),
      );
      await coordinator.dispatch(
        'session-1',
        'Latest output',
        context({ kind, label: 'npm test' }),
      );
      await coordinator.dispatch('session-1', '  ', context({ kind }));
      expect(packets).toEqual([]);

      await coordinator.dispatch(
        'session-1',
        '',
        context({ kind, status: 'completed', turnComplete: true }),
      );

      expect(packets).toEqual([
        {
          kind,
          status: 'completed',
          text: 'Latest output',
          label: 'npm test',
          partial: false,
          turnComplete: true,
        },
      ]);
      expect(options.createDelivery).toHaveBeenCalledWith('session-1', {
        target,
        sourceLabel: 'Named session',
      });
      expectIdle(coordinator);
    },
  );

  it('aggregates unclaimed per-task background output until its turn completes', async () => {
    const { coordinator, packets, options } = fixture({
      outputMode: 'per_task',
    });
    await expect(
      coordinator.dispatch('session-1', 'Earlier', context()),
    ).resolves.toBe(true);
    await expect(
      coordinator.dispatch('session-1', 'Latest', context()),
    ).resolves.toBe(true);
    expect(options.resolveDelivery).toHaveBeenCalledOnce();
    expect(packets).toEqual([]);
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    expect(packets).toEqual([
      expect.objectContaining({ text: 'Latest', turnComplete: true }),
    ]);
    expectIdle(coordinator);
  });

  it('keeps separate task and turn results separate', async () => {
    const { coordinator, packets } = fixture();
    const turns = [
      ['task-1', 'turn-1'],
      ['task-2', 'turn-1'],
      ['task-1', 'turn-2'],
    ];
    for (const [taskId, turnId] of turns) {
      await coordinator.dispatch(
        'session-1',
        taskId + '/' + turnId,
        context({ taskId, turnId }),
      );
    }
    expect(packets).toEqual([]);
    for (const [taskId, turnId] of turns) {
      await coordinator.dispatch(
        'session-1',
        '',
        context({ taskId, turnId, status: 'completed', turnComplete: true }),
      );
    }
    expect(packets.map((packet) => packet.text)).toEqual([
      'task-1/turn-1',
      'task-2/turn-1',
      'task-1/turn-2',
    ]);
    expectIdle(coordinator);
  });

  it('parks an empty terminal marker while the target is resolving', async () => {
    const pending = deferred<BackgroundOutputTarget>();
    const { coordinator, packets, target } = fixture({
      resolveDelivery: () => pending.promise,
    });
    const response = coordinator.dispatch('session-1', 'Result', context());
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'failed', turnComplete: true }),
    );
    expect(packets).toEqual([]);
    pending.resolve({ target });
    await response;
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Result',
        status: 'failed',
        turnComplete: true,
        partial: false,
      }),
    ]);
  });

  it('retains arrival order when concurrent target resolutions finish backwards', async () => {
    const first = deferred<BackgroundOutputTarget>();
    const second = deferred<BackgroundOutputTarget>();
    const resolveDelivery = vi
      .fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { coordinator, packets, target } = fixture({ resolveDelivery });
    const earlier = coordinator.dispatch('session-1', 'Earlier', context());
    const latest = coordinator.dispatch('session-1', 'Latest', context());
    second.resolve({ target });
    await latest;
    await coordinator.dispatch(
      'session-1',
      '',
      context({
        status: 'completed',
        turnComplete: true,
        label: 'terminal label',
      }),
    );
    expect(packets).toEqual([]);
    first.resolve({ target });
    await earlier;
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Latest',
        turnComplete: true,
        partial: false,
        label: 'terminal label',
      }),
    ]);
  });

  it('emits bounded partial output and a later empty terminal result', async () => {
    const { coordinator, packets } = fixture();
    await coordinator.dispatch('session-1', 'Result', context());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Result',
        partial: true,
        turnComplete: false,
      }),
    ]);
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    expect(packets[1]).toEqual(
      expect.objectContaining({ text: '', partial: false, turnComplete: true }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries using the same per-delivery closure and refreshed terminal packet', async () => {
    const { coordinator, packets, send, options } = fixture();
    send.mockRejectedValueOnce(new Error('Transient send failure'));
    await coordinator.dispatch('session-1', 'Result', context());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await coordinator.dispatch(
      'session-1',
      '',
      context({
        status: 'completed',
        turnComplete: true,
        label: 'terminal label',
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(options.createDelivery).toHaveBeenCalledOnce();
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Result',
        partial: false,
        turnComplete: true,
        label: 'terminal label',
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mistake an in-flight partial delivery for a delivered terminal result', async () => {
    const inFlight = deferred<{ turnComplete: boolean }>();
    const { coordinator, packets, send } = fixture();
    send.mockImplementationOnce(() => inFlight.promise);
    await coordinator.dispatch('session-1', 'Result', context());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    inFlight.resolve({ turnComplete: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(packets).toEqual([
      expect.objectContaining({ text: '', partial: false, turnComplete: true }),
    ]);
  });

  it('honors a terminal-false receipt from a retry with already-sent chunks', async () => {
    const { coordinator, packets, send } = fixture();
    send
      .mockRejectedValueOnce(new Error('Some chunks were sent'))
      .mockResolvedValueOnce({ turnComplete: false });
    await coordinator.dispatch('session-1', 'Result', context());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(packets).toEqual([
      expect.objectContaining({ text: '', partial: false, turnComplete: true }),
    ]);
  });

  it('stops after a permanent delivery error', async () => {
    const { coordinator, send, options } = fixture({
      isRetryableError: () => false,
    });
    send.mockRejectedValue(new Error('Permanent rejection'));
    await coordinator.dispatch(
      'session-1',
      'Result',
      context({ status: 'completed', turnComplete: true }),
    );
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(send).toHaveBeenCalledOnce();
    expect(options.createDelivery).toHaveBeenCalledOnce();
    expect(options.log).toHaveBeenCalledExactlyOnceWith(
      'background response delivery failed (attempt 1): Permanent rejection\n',
    );
    expectIdle(coordinator);
  });

  it('bounds transient delivery retries', async () => {
    const { coordinator, send } = fixture();
    send.mockRejectedValue(new Error('Unavailable'));
    await coordinator.dispatch(
      'session-1',
      'Result',
      context({ status: 'completed', turnComplete: true }),
    );
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains pending output as partial without waiting for target resolution', async () => {
    const pending = deferred<BackgroundOutputTarget>();
    const { coordinator, target, packets, options } = fixture({
      resolveDelivery: () => pending.promise,
    });
    const response = coordinator.dispatch(
      'session-1',
      'Held result',
      context(),
    );
    await coordinator.drain('session-1');
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Held result',
        partial: true,
        turnComplete: true,
      }),
    ]);
    expect(options.createDelivery).toHaveBeenCalledWith('session-1', {
      target,
      sourceLabel: 'Named session',
    });
    pending.resolve({ target });
    await response;
    expect(packets).toHaveLength(1);
    expectIdle(coordinator);
  });

  it('does not deliver to a target whose session ownership changed while resolving', async () => {
    const pending = deferred<BackgroundOutputTarget>();
    const { coordinator, target, packets, options } = fixture({
      resolveDelivery: () => pending.promise,
    });
    const response = coordinator.dispatch(
      'session-1',
      'Result',
      context({ status: 'completed', turnComplete: true }),
    );
    options.getTarget.mockReturnValue({ ...target, chatId: 'replacement' });
    pending.resolve({ target });
    await response;
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(packets).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an in-flight delivery and its buffered tail when draining', async () => {
    const first = deferred<{ turnComplete: boolean }>();
    const tail = deferred<{ turnComplete: boolean }>();
    const { coordinator, send } = fixture();
    send.mockImplementationOnce(() => first.promise);
    send.mockImplementationOnce(() => tail.promise);
    await coordinator.dispatch('session-1', 'First', context());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await coordinator.dispatch('session-1', 'Tail', context());
    let drained = false;
    const drain = coordinator.drain('session-1').then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    first.resolve({ turnComplete: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      text: 'Tail',
      turnComplete: true,
      partial: true,
    });
    expect(drained).toBe(false);
    tail.resolve({ turnComplete: true });
    await drain;
    expect(drained).toBe(true);
    expectIdle(coordinator);
  });

  it('reports pending output discarded during drain after ownership changes', async () => {
    const pending = deferred<BackgroundOutputTarget>();
    const { coordinator, target, packets, options } = fixture({
      resolveDelivery: () => pending.promise,
    });
    const response = coordinator.dispatch('session-1', 'Result', context());
    options.getTarget.mockReturnValue({ ...target, chatId: 'replacement' });
    await coordinator.drain('session-1');
    expect(packets).toEqual([]);
    expect(options.log).toHaveBeenCalledExactlyOnceWith(
      'background response target unavailable during drain; 1 buffered segment(s) discarded\n',
    );
    expectIdle(coordinator);
    pending.resolve({ target });
    await response;
    expect(packets).toEqual([]);
    expectIdle(coordinator);
  });

  it('logs a failed drain without leaving retries after shutdown', async () => {
    const { coordinator, send, options } = fixture();
    send.mockRejectedValue(new Error('Unavailable'));
    await coordinator.dispatch('session-1', 'Result', context());
    await coordinator.drain();
    expect(send).toHaveBeenCalledOnce();
    expect(options.log).toHaveBeenCalledExactlyOnceWith(
      'background response delivery failed (attempt 1): Unavailable\n',
    );
    expectIdle(coordinator);
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(send).toHaveBeenCalledOnce();
  });

  it('reports the pre-clear buffered count when target resolution retries are exhausted', async () => {
    const { coordinator, options, packets } = fixture({
      resolveDelivery: vi.fn(async () => undefined),
    });
    await coordinator.dispatch('session-1', 'Result', context());
    await coordinator.dispatch(
      'session-1',
      '',
      context({ turnComplete: true }),
    );
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(options.resolveDelivery).toHaveBeenCalledTimes(3);
    expect(options.log).toHaveBeenCalledExactlyOnceWith(
      'background response target unresolved after 3 attempts; 1 buffered segment(s) discarded\n',
    );
    expect(packets).toEqual([]);
    expectIdle(coordinator);
  });

  it('retains resolution loss when an outstanding resolver recovers the active turn', async () => {
    const late = deferred<BackgroundOutputTarget>();
    const latest = deferred<BackgroundOutputTarget>();
    const resolveDelivery = vi
      .fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(undefined);
    const { coordinator, packets, target, options } = fixture({
      resolveDelivery,
    });
    await coordinator.dispatch('session-1', 'Discarded first', context());
    const recovering = coordinator.dispatch(
      'session-1',
      'Discarded second',
      context(),
    );
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(resolveDelivery).toHaveBeenCalledTimes(4);
    expect(options.log).toHaveBeenCalledWith(
      'background response target unresolved after 3 attempts; 2 buffered segment(s) discarded\n',
    );
    resolveDelivery.mockReturnValueOnce(latest.promise);
    const recovered = coordinator.dispatch(
      'session-1',
      'Recovered tail',
      context(),
    );
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    late.resolve({ target });
    await recovering;
    expect(packets).toEqual([]);
    latest.resolve({ target });
    await recovered;
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Recovered tail',
        partial: true,
        turnComplete: true,
      }),
    ]);
    expectIdle(coordinator);
  });

  it('does not inherit a completed resolution loss when the same key starts a fresh turn', async () => {
    const late = deferred<BackgroundOutputTarget>();
    const resolveDelivery = vi
      .fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(undefined);
    const { coordinator, packets, target } = fixture({ resolveDelivery });
    await coordinator.dispatch('session-1', 'Discarded first', context());
    const earlier = coordinator.dispatch(
      'session-1',
      'Discarded second',
      context(),
    );
    await coordinator.dispatch(
      'session-1',
      '',
      context({ turnComplete: true }),
    );
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(resolveDelivery).toHaveBeenCalledTimes(4);
    resolveDelivery.mockResolvedValue({ target });
    await coordinator.dispatch('session-1', 'Fresh result', context());
    late.resolve({ target });
    await earlier;
    expect(packets).toEqual([]);
    await coordinator.dispatch(
      'session-1',
      '',
      context({ status: 'completed', turnComplete: true }),
    );
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Fresh result',
        partial: false,
        turnComplete: true,
      }),
    ]);
    expectIdle(coordinator);
  });

  it('does not reopen a completed discarded turn when its last resolver succeeds', async () => {
    const late = deferred<BackgroundOutputTarget>();
    const resolveDelivery = vi
      .fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(late.promise)
      .mockResolvedValue(undefined);
    const { coordinator, packets, target } = fixture({ resolveDelivery });
    await coordinator.dispatch('session-1', 'Discarded first', context());
    const earlier = coordinator.dispatch(
      'session-1',
      'Discarded second',
      context(),
    );
    await coordinator.dispatch(
      'session-1',
      '',
      context({ turnComplete: true }),
    );
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(resolveDelivery).toHaveBeenCalledTimes(4);
    late.resolve({ target });
    await earlier;
    expect(packets).toEqual([]);
    expectIdle(coordinator);
  });

  it.each([false, true])(
    'recovers from a thrown target resolution with terminal=%s',
    async (terminal) => {
      const resolveDelivery =
        vi.fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>();
      const { coordinator, target, packets } = fixture({ resolveDelivery });
      resolveDelivery.mockRejectedValueOnce(new Error('Owner lock failed'));
      resolveDelivery.mockResolvedValue({ target, sourceLabel: 'Recovered' });
      await expect(
        coordinator.dispatch('session-1', 'Result', context()),
      ).rejects.toThrow('Owner lock failed');
      if (terminal) {
        await coordinator.dispatch(
          'session-1',
          '',
          context({
            status: 'completed',
            turnComplete: true,
            label: 'recovered label',
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(30 * 1000);
      if (!terminal) {
        expect(packets).toEqual([]);
        await coordinator.dispatch(
          'session-1',
          '',
          context({
            status: 'completed',
            turnComplete: true,
            label: 'recovered label',
          }),
        );
      }
      expect(resolveDelivery).toHaveBeenCalledTimes(2);
      expect(packets).toEqual([
        expect.objectContaining({
          text: 'Result',
          status: 'completed',
          turnComplete: true,
          label: 'recovered label',
        }),
      ]);
      expectIdle(coordinator);
    },
  );

  it.each(['throw', 'unavailable'] as const)(
    'settles the existing aggregation when a concurrent resolver ends with %s',
    async (failure) => {
      const first = deferred<BackgroundOutputTarget | undefined>();
      const resolveDelivery =
        vi.fn<BackgroundOutputCoordinatorOptions['resolveDelivery']>();
      const { coordinator, target, packets } = fixture({ resolveDelivery });
      resolveDelivery.mockReturnValueOnce(first.promise);
      resolveDelivery.mockResolvedValue({ target });
      const earlier = coordinator.dispatch('session-1', 'Earlier', context());
      await coordinator.dispatch(
        'session-1',
        'Latest',
        context({ label: 'latest label' }),
      );
      await coordinator.dispatch(
        'session-1',
        '',
        context({ status: 'completed', turnComplete: true }),
      );
      expect(packets).toEqual([]);
      if (failure === 'throw') {
        const rejected = expect(earlier).rejects.toThrow('Owner lock failed');
        first.reject(new Error('Owner lock failed'));
        await rejected;
      } else {
        first.resolve(undefined);
        await earlier;
      }
      expect(packets).toEqual([
        expect.objectContaining({
          text: 'Latest',
          label: 'latest label',
          status: 'completed',
          turnComplete: true,
        }),
      ]);
      expectIdle(coordinator);
    },
  );
});

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
        context({ kind }),
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
          label: undefined,
          partial: false,
          turnComplete: true,
        },
      ]);
      expect(options.createDelivery).toHaveBeenCalledWith('session-1', {
        target,
        sourceLabel: 'Named session',
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps separate task and turn results separate', async () => {
    const { coordinator, packets } = fixture();
    for (const [taskId, turnId] of [
      ['task-1', 'turn-1'],
      ['task-2', 'turn-1'],
      ['task-1', 'turn-2'],
    ]) {
      await coordinator.dispatch(
        'session-1',
        taskId + '/' + turnId,
        context({ taskId, turnId, status: 'completed', turnComplete: true }),
      );
    }
    expect(packets.map((packet) => packet.text)).toEqual([
      'task-1/turn-1',
      'task-2/turn-1',
      'task-1/turn-2',
    ]);
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
      context({ status: 'completed', turnComplete: true }),
    );
    expect(packets).toEqual([]);
    first.resolve({ target });
    await earlier;
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Latest',
        turnComplete: true,
        partial: false,
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
      context({ status: 'completed', turnComplete: true }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(options.createDelivery).toHaveBeenCalledOnce();
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Result',
        partial: false,
        turnComplete: true,
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
    expect(vi.getTimerCount()).toBe(0);
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
    const { coordinator, target, packets } = fixture({
      resolveDelivery: () => pending.promise,
    });
    const response = coordinator.dispatch(
      'session-1',
      'Held result',
      context(),
    );
    coordinator.drain('session-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(packets).toEqual([
      expect.objectContaining({
        text: 'Held result',
        partial: true,
        turnComplete: true,
      }),
    ]);
    pending.resolve({ target });
    await response;
    expect(packets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
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
});

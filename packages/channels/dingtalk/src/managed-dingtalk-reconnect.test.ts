/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #17173 R11: the SDK arms setTimeout(this.connect, 1000) from EVERY socket's
// close event without reading its own `reconnecting` flag, and `this.connect`
// is this wrapper's guardedConnect, which arms its own retry on failure. One
// drop whose replacement also fails therefore left TWO independent reconnect
// chains, compounding on every further close. Reconnect is centralized in the
// wrapper with SDK autoReconnect off. Only the network boundary (ws, axios) is
// fake; the SDK and the production wrapper run for real, and the witness counts
// ACTIVE TIMERS, not socket state.

const wsState = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('ws', () => {
  class FakeWebSocket {
    readyState = 0;
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    ping = vi.fn();
    terminate = vi.fn();
    close = vi.fn(() => {
      this.readyState = 3;
      this.emit('close');
    });
    constructor() {
      wsState.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(cb);
    }
    off(event: string, cb: (...args: unknown[]) => void): void {
      this.listeners.get(event)?.delete(cb);
    }
    emit(event: string, ...args: unknown[]): void {
      this.listeners.get(event)?.forEach((cb) => cb(...args));
    }
    open(): void {
      this.readyState = 1;
      this.emit('open');
    }
  }
  return { default: FakeWebSocket };
});

vi.mock('axios', () => {
  const post = vi.fn(async () => ({
    data: { endpoint: 'wss://fake.invalid', ticket: 'tk' },
  }));
  const get = vi.fn(async () => ({
    status: 200,
    data: { access_token: 'token' },
  }));
  return { default: Object.assign(post, { get }) };
});

import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

type FakeSocket = {
  readyState: number;
  open: () => void;
  emit: (event: string, ...args: unknown[]) => void;
};

const SETTINGS = {
  clientId: 'robot-app',
  clientSecret: 'secret',
  pollInterval: 2_000,
};

// The wrapper's own reconnect interval (RECONNECT_RETRY_MS). The SDK's 1s
// reconnectInterval is deliberately no longer in play: autoReconnect is off.
const RETRY_MS = 5_000;

const latest = (): FakeSocket =>
  wsState.instances[wsState.instances.length - 1] as FakeSocket;
const sockets = (): number => wsState.instances.length;

const startOpen = async () => {
  const { createStreamClient } = createManagedDingtalkDeps();
  const stream = createStreamClient(SETTINGS, () => true);
  const connecting = stream.connect();
  await vi.advanceTimersByTimeAsync(0);
  latest().open();
  await connecting;
  return stream;
};

beforeEach(() => {
  wsState.instances.length = 0;
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managed DingTalk reconnect arbitration (#17173 R11)', () => {
  it('a drop whose replacement also fails leaves one pending reconnect, not two', async () => {
    const stream = await startOpen();
    expect(vi.getTimerCount()).toBe(1); // the open socket's heartbeat

    latest().emit('close');
    // Heartbeat retired, one reconnect armed. With SDK autoReconnect on this
    // was already the SDK's timer; the wrapper's own retry then doubled it.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toBe(2);
    latest().emit('close'); // the replacement closes before it opens
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    // Every further drop must stay on the same single chain. Before the fix
    // the pending count climbed 2 → 3 → 4 → 5 across these rounds.
    for (let round = 0; round < 4; round++) {
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await vi.advanceTimersByTimeAsync(0);
      latest().emit('close');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
    }

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a healthy socket dropping still reconnects, now that the SDK does not', async () => {
    const stream = await startOpen();
    latest().emit('close');
    expect(sockets()).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toBe(2);
    latest().open();
    await vi.advanceTimersByTimeAsync(0);
    // Connected again: the heartbeat is back and no reconnect is pending.
    expect(vi.getTimerCount()).toBe(1);
    expect(latest().readyState).toBe(1);

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a retry firing while an attempt is in flight re-arms instead of opening a second socket', async () => {
    const stream = await startOpen();
    latest().emit('close'); // arms the single retry
    expect(vi.getTimerCount()).toBe(1);

    // A connect arriving through the same entry the adapter uses, before that
    // retry fires, builds its socket but never opens it — the attempt stays
    // genuinely unresolved while the retry comes due.
    const connecting = stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toBe(2);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    // The running attempt owns the socket: no third one, and the reconnect is
    // re-armed rather than dropped on the floor — two timers, the in-flight
    // attempt's connect timeout and the re-armed retry.
    expect(sockets()).toBe(2);
    expect(vi.getTimerCount()).toBe(2);

    latest().open();
    await connecting;
    // The successful attempt clears the re-armed retry; only its heartbeat runs.
    expect(sockets()).toBe(2);
    expect(vi.getTimerCount()).toBe(1);

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a concurrent connect joins the running attempt instead of reporting a fake success', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const first = stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets()).toBe(1); // built, never opened

    let settled = false;
    const second = stream.connect().then(
      () => {
        settled = true;
        return 'resolved';
      },
      () => {
        settled = true;
        return 'rejected';
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    // The only socket is still opening: the second caller must not be told
    // "connected", and must not open a socket of its own.
    expect(settled).toBe(false);
    expect(sockets()).toBe(1);

    latest().emit('close'); // the attempt fails before the socket opens
    await expect(first).rejects.toThrow(
      /check the clientId\/clientSecret and network/,
    );
    // Joining means sharing the outcome, not just the socket count.
    await expect(second).resolves.toBe('rejected');
    expect(sockets()).toBe(1);

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a first connect that never opens surfaces and arms no retry', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    latest().emit('close'); // closes before it ever opens
    await expect(connecting).rejects.toThrow(
      /check the clientId\/clientSecret and network/,
    );
    // A silent retry loop here would hide a bad credential from the operator.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(sockets()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    stream.disconnect();
  });
});

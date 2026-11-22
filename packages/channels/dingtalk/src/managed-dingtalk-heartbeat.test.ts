/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #17173 R5: the REAL SDK's keepAlive creates a heartbeat interval on every
// socket open, never clears it on close, and the next open overwrites the only
// stored handle — the old interval keeps pinging the replacement socket. The
// wrapper must retire it on close. Only the network boundary (ws, axios) is
// fake here; the SDK and the production wrapper run for real, and the witness
// asserts the ACTIVE TIMER COUNT, not socket state.

type FakeSocket = {
  readyState: number;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  off: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  open: () => void;
};

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

// Endpoint discovery is the wrapper's own bounded fetch (#17173 R11), so the
// network boundary to fake here is fetch rather than the SDK's axios.
const stubDiscovery = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        String(url).includes('gettoken')
          ? { access_token: 'token' }
          : { endpoint: 'wss://fake.invalid', ticket: 'tk' },
    })),
  );

import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

const SETTINGS = {
  clientId: 'robot-app',
  clientSecret: 'secret',
  pollInterval: 2_000,
};

// DWClient.heartbeat_interval (dingtalk-stream-sdk-nodejs 2.0.4,
// dist/client.mjs — a private field); a dependency bump that changes it must
// change this with it (#17462 R2-1). Reconnect is no longer the SDK's: the
// wrapper owns it with autoReconnect off (#17173 R11), so the advance below
// uses the wrapper's RECONNECT_RETRY_MS, not DWClient.reconnectInterval.
const RECONNECT_RETRY_MS = 5_000;
const SDK_HEARTBEAT_MS = 8_000;

const latestSocket = (): FakeSocket =>
  wsState.instances[wsState.instances.length - 1] as FakeSocket;
const socketCount = (): number => wsState.instances.length;

beforeEach(() => {
  wsState.instances.length = 0;
  stubDiscovery();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('managed DingTalk heartbeat timer cleanup (#17173 R5)', () => {
  it('a reconnect retires the old heartbeat interval (timer count stays 1)', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect();
    await vi.advanceTimersByTimeAsync(0); // getEndpoint resolves, socket built
    latestSocket().open();
    await connecting;
    // Exactly one active timer: the heartbeat interval of the open socket.
    expect(vi.getTimerCount()).toBe(1);

    // Network drop: the SDK no longer reconnects (autoReconnect is off) but it
    // still does not clear the interval; the wrapper's close listener retires
    // it and arms the single retry.
    latestSocket().emit('close');
    // Only the wrapper's reconnect timeout remains.
    expect(vi.getTimerCount()).toBe(1);

    // Nothing may reconnect before that timeout: waiting the full interval
    // would also be satisfied by the SDK's own faster chain, so the case would
    // pass with this PR reverted.
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1);
    expect(socketCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1); // the reconnect attempt runs
    await vi.advanceTimersByTimeAsync(0);
    const replacement = latestSocket();
    replacement.open();
    await vi.advanceTimersByTimeAsync(0);
    // Without the retire, the first interval survives the overwrite and the
    // count is 2 here.
    expect(vi.getTimerCount()).toBe(1);

    // One heartbeat period on the replacement socket: exactly one ping, and
    // no stale interval terminates it.
    await vi.advanceTimersByTimeAsync(SDK_HEARTBEAT_MS);
    expect(replacement.ping).toHaveBeenCalledTimes(1);
    expect(replacement.terminate).not.toHaveBeenCalled();

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the retire re-arms on every reconnect, not just the first socket', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect();
    await vi.advanceTimersByTimeAsync(0);
    latestSocket().open();
    await connecting;
    expect(vi.getTimerCount()).toBe(1);

    // First drop: socket B replaces socket A, and only on the wrapper's own
    // schedule — the same bound as the case above.
    latestSocket().emit('close');
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS - 1);
    expect(socketCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const socketB = latestSocket();
    socketB.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    // Second drop: socket C replaces socket B. An arm-once retire (armed only
    // on the first socket) leaks B's interval into C here — the count would
    // be 2, and the leaked interval would survive disconnect.
    socketB.emit('close');
    await vi.advanceTimersByTimeAsync(RECONNECT_RETRY_MS);
    await vi.advanceTimersByTimeAsync(0);
    const socketC = latestSocket();
    socketC.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SDK_HEARTBEAT_MS);
    expect(socketC.ping).toHaveBeenCalledTimes(1);
    expect(socketC.terminate).not.toHaveBeenCalled();

    stream.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

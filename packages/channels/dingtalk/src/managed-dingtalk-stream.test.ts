/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  behavior: 'ok' as 'ok' | 'fail',
  calls: 0,
  disconnects: 0,
  connectGate: null as null | { promise: Promise<void>; resolve: () => void },
  instance: null as unknown as { onDownStream: (data: unknown) => void },
  registered: null as null | { topic: unknown; cb: (m: unknown) => void },
  acks: [] as Array<{ id: string; payload: { status: string } }>,
  // The options the deps wrapper passed to the SDK constructor (R12).
  constructorOptions: null as unknown,
  // Mirror the SDK getEndpoint() credential log when armed (R12).
  logEndpoint: false,
  // Whether the constructed socket ever emits 'open'. The real SDK resolves
  // connect() on construction; the deps wrapper must wait for 'open' (R10-1).
  socketOpen: true,
  // When the socket never opens, emit this event instead (R12).
  socketFailEvent: null as null | 'error' | 'close',
  socket: null as null | {
    readyState: number;
    on: (e: string, cb: (...a: unknown[]) => void) => void;
    off: (e: string, cb: (...a: unknown[]) => void) => void;
    emit: (e: string, ...a: unknown[]) => void;
  },
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => {
  class DWClient {
    config: {
      clientId?: string;
      clientSecret?: string;
      autoReconnect: boolean;
      subscriptions: Array<{ type: string; topic: string }>;
    };
    debug = false;
    socket: unknown = null;
    constructor(options?: unknown) {
      mockState.constructorOptions = options;
      const opts = options as
        | { clientId?: string; clientSecret?: string }
        | undefined;
      this.config = {
        clientId: opts?.clientId,
        clientSecret: opts?.clientSecret,
        autoReconnect: true,
        subscriptions: [],
      };
      mockState.instance = this as unknown as typeof mockState.instance;
    }
    // Mirror the real SDK's structure: connect() awaits getEndpoint(), and the
    // credential log lives in getEndpoint(), not in connect(). The wrapper
    // replaces getEndpoint with its own silent discovery (#17173 R11), so this
    // log is what must never run.
    async getEndpoint(): Promise<this> {
      if (mockState.logEndpoint) {
        // eslint-disable-next-line no-console -- mirrors the real SDK credential log
        console.log('getEndpoint config', {
          clientSecret: this.config.clientSecret,
        });
      }
      return this;
    }
    // Simulate the SDK dispatch: it console.log()s every raw frame (ungated by
    // its debug flag) and JSON.parse + routes with NO error boundary — the deps
    // wrapper must suppress the log (R3-4) and provide the boundary (R3-1).
    onDownStream(data: unknown): void {
      // eslint-disable-next-line no-console -- mirrors the real SDK's raw-frame log
      console.log(data);
      const msg = JSON.parse(data as string) as {
        type?: string;
        headers?: { messageId?: string };
      };
      if (msg.type === 'CALLBACK' && mockState.registered) {
        mockState.registered.cb(msg);
      }
    }
    registerCallbackListener(topic: unknown, cb: (m: unknown) => void): void {
      mockState.registered = { topic, cb };
    }
    send(id: string, payload: { status: string }): void {
      mockState.acks.push({ id, payload });
    }
    async connect(): Promise<void> {
      mockState.calls += 1;
      await this.getEndpoint();
      if (mockState.connectGate) {
        await mockState.connectGate.promise;
      }
      if (mockState.behavior === 'fail') {
        // Mirror an AxiosError: config is an own enumerable property and
        // toJSON() includes config.url, which carries the gettoken appsecret.
        const error = new Error('getEndpoint failed') as Error & {
          config: { url: string };
          toJSON: () => unknown;
        };
        error.config = {
          url: 'https://oapi.dingtalk.com/gettoken?appkey=AK&appsecret=SUPERSECRET',
        };
        error.toJSON = () => ({ message: error.message, config: error.config });
        throw error;
      }
      // Mirror the SDK: construct the socket and resolve on construction; the
      // 'open' event (emitted async) is what actually makes the stream live.
      const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
      const socket = {
        readyState: 0,
        on: (e: string, cb: (...a: unknown[]) => void) => {
          if (!listeners.has(e)) listeners.set(e, new Set());
          listeners.get(e)!.add(cb);
        },
        off: (e: string, cb: (...a: unknown[]) => void) => {
          listeners.get(e)?.delete(cb);
        },
        emit: (e: string, ...a: unknown[]) => {
          listeners.get(e)?.forEach((cb) => cb(...a));
        },
      };
      this.socket = socket;
      mockState.socket = socket;
      if (mockState.socketOpen) {
        setImmediate(() => {
          socket.readyState = 1;
          socket.emit('open');
        });
      } else if (mockState.socketFailEvent) {
        const event = mockState.socketFailEvent;
        setImmediate(() => {
          socket.emit(event);
        });
      }
    }
    disconnect(): void {
      mockState.disconnects += 1;
    }
  }
  return {
    DWClient,
    TOPIC_ROBOT: 'robot',
    EventAck: { SUCCESS: 'SUCCESS', LATER: 'LATER' },
  };
});

import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

const SETTINGS = {
  clientId: 'robot-app',
  clientSecret: 'secret',
  pollInterval: 2_000,
};

function robotFrame(messageId: string): string {
  return JSON.stringify({
    type: 'CALLBACK',
    headers: { messageId, topic: 'robot' },
    data: '{"msgId":"m1"}',
  });
}

beforeEach(() => {
  mockState.behavior = 'ok';
  mockState.calls = 0;
  mockState.disconnects = 0;
  mockState.connectGate = null;
  mockState.registered = null;
  mockState.acks = [];
  mockState.constructorOptions = null;
  mockState.logEndpoint = false;
  mockState.socketOpen = true;
  mockState.socketFailEvent = null;
  mockState.socket = null;
  // The wrapper's own endpoint discovery uses fetch (#17173 R11).
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('managed DingTalk stream connect (R1-9)', () => {
  it('the first connect failure propagates — no healthy start on a dead stream', async () => {
    mockState.behavior = 'fail';
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    // The failure must surface, but the SDK error object (which serializes the
    // gettoken appsecret) must not escape — redact the payload, not the failure.
    const rejection = await stream.connect().then(
      () => undefined,
      (error) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection.message)).toContain('connect failed');
    expect(JSON.stringify(rejection)).not.toContain('SUPERSECRET');
  });

  it('a socket that never opens rejects the first connect, not a deaf start (R10-1)', async () => {
    vi.useFakeTimers();
    // The SDK resolves connect() on construction; a blocked wss: upgrade means
    // 'open' never fires. The wrapper must reject, not report a healthy start.
    mockState.socketOpen = false;
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect();
    const assertion = expect(connecting).rejects.toThrow('connect failed');
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    // The timeout must also close the socket the abandoned attempt opened, so
    // no zombie keeps the heartbeat armed (R11 deps).
    expect(mockState.disconnects).toBeGreaterThanOrEqual(1);
    stream.disconnect();
  });

  it('a successful connect clears a stale retry timer (R11 deps)', async () => {
    // Keep setImmediate real so the mock socket's async 'open' fires.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // call 1 succeeds, everConnected = true
    mockState.behavior = 'fail';
    await stream.connect(); // call 2 fails, arms the retry
    expect(mockState.calls).toBe(2);
    mockState.behavior = 'ok';
    await stream.connect(); // call 3 succeeds, must clear the stale retry
    expect(mockState.calls).toBe(3);
    // Past the retry interval: the cleared timer must not fire a fourth connect.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockState.calls).toBe(3);
    stream.disconnect();
  });

  it('a reconnect failure after a successful connect is swallowed', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // success arms everConnected
    mockState.behavior = 'fail';
    await expect(stream.connect()).resolves.toBeUndefined();
    stream.disconnect();
  });

  it('a failed reconnect re-arms a retry instead of going permanently deaf', async () => {
    // Keep setImmediate real so the mock socket's async 'open' fires; only the
    // retry timer needs to be fake.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // call 1 succeeds
    mockState.behavior = 'fail';
    await stream.connect(); // call 2 (reconnect) fails, re-arms the retry
    expect(mockState.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000); // the re-armed retry fires
    expect(mockState.calls).toBeGreaterThanOrEqual(3);
    stream.disconnect();
  });

  it('after disconnect a pending connect no-ops instead of reopening a socket', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    stream.disconnect();
    await stream.connect();
    expect(mockState.calls).toBe(0);
  });
});

describe('managed DingTalk stream frame path (R3-1 / R3-3 / R3-4)', () => {
  it('a queued robot frame is acked SUCCESS and dispatched without logging', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const received: Array<{ id: string; data: string }> = [];
    const { createStreamClient } = createManagedDingtalkDeps();
    createStreamClient(SETTINGS, (id, data) => {
      received.push({ id, data });
      return true;
    });
    mockState.instance.onDownStream(robotFrame('msg-1'));
    expect(received).toEqual([{ id: 'msg-1', data: '{"msgId":"m1"}' }]);
    expect(mockState.acks.map((ack) => [ack.id, ack.payload.status])).toEqual([
      ['msg-1', 'SUCCESS'],
    ]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('an unqueued frame is acked LATER so the provider redelivers it (R3-3)', () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    createStreamClient(SETTINGS, () => false); // inbox full / not running
    mockState.instance.onDownStream(robotFrame('msg-full'));
    expect(mockState.acks.map((ack) => [ack.id, ack.payload.status])).toEqual([
      ['msg-full', 'LATER'],
    ]);
  });

  it('a malformed frame is swallowed, not thrown through the socket handler (R3-1)', () => {
    const received: string[] = [];
    const { createStreamClient } = createManagedDingtalkDeps();
    createStreamClient(SETTINGS, (id) => {
      received.push(id);
      return true;
    });
    expect(() => mockState.instance.onDownStream('null')).not.toThrow();
    expect(() => mockState.instance.onDownStream('{oops')).not.toThrow();
    expect(received).toEqual([]);
    expect(mockState.acks).toEqual([]);
  });

  it('a CALLBACK frame without a messageId is dropped without acking (R3-1)', () => {
    const received: string[] = [];
    const { createStreamClient } = createManagedDingtalkDeps();
    createStreamClient(SETTINGS, (id) => {
      received.push(id);
      return true;
    });
    const noMessageId = JSON.stringify({
      type: 'CALLBACK',
      headers: { topic: 'robot' },
      data: '{}',
    });
    expect(() => mockState.instance.onDownStream(noMessageId)).not.toThrow();
    expect(received).toEqual([]);
    expect(mockState.acks).toEqual([]);
  });
});

describe('managed DingTalk stream reconnect lifecycle (R4-2 / R4-3)', () => {
  it('closes a socket opened by an in-flight connect that resolves after disconnect (R4-2)', async () => {
    let resolveConnect!: () => void;
    mockState.connectGate = {
      promise: new Promise<void>((resolve) => {
        resolveConnect = resolve;
      }),
      resolve: () => resolveConnect(),
    };
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect(); // in flight, gated
    stream.disconnect(); // lands while the attempt is in flight
    const disconnectsBeforeResolve = mockState.disconnects;
    mockState.connectGate.resolve();
    await connecting;
    // The resolve handler must close the socket the attempt opened, so no
    // zombie socket / heartbeat survives the disconnect.
    expect(mockState.disconnects).toBeGreaterThan(disconnectsBeforeResolve);
  });

  it('logs a permanently failing reconnect only on the transition (R4-3)', async () => {
    // Keep setImmediate real so the mock socket's async 'open' fires; only the
    // retry timer needs to be fake.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // call 1 succeeds, everConnected = true
    mockState.behavior = 'fail';
    await stream.connect(); // call 2 fails: logs once, re-arms the retry
    await vi.advanceTimersByTimeAsync(5_000); // call 3 fails: must not re-log
    const reconnectLines = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('reconnect failed'),
    ).length;
    expect(reconnectLines).toBe(1);
    stream.disconnect();
  });
});

describe('managed DingTalk stream SDK wiring pins (#17173 R12)', () => {
  it('passes clientId, clientSecret and keepAlive, and turns SDK autoReconnect off', () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    createStreamClient(SETTINGS, () => true);
    expect(mockState.constructorOptions).toEqual({
      clientId: 'robot-app',
      clientSecret: 'secret',
      keepAlive: true,
    });
    // Reconnect is owned by the wrapper; the SDK's own close-triggered
    // reconnect would run a second chain alongside it (#17173 R11). The
    // constructor's options type omits the field, so it is assigned on the
    // instance, whose config type carries it.
    expect(
      (mockState.instance as unknown as { config: { autoReconnect: boolean } })
        .config.autoReconnect,
    ).toBe(false);
  });

  it('never runs the SDK credential log, because discovery is replaced', async () => {
    mockState.logEndpoint = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect();
    // The double logs the clientSecret inside its own getEndpoint, as the real
    // SDK does. The wrapper replaces that method with silent discovery, so the
    // log must never run — not be muted after the fact (#17173 R11).
    expect(logSpy).not.toHaveBeenCalled();
    // Suppression is scoped to the attempt: logging works again afterwards.
    // eslint-disable-next-line no-console -- probing the restored console
    console.log('after connect');
    expect(logSpy).toHaveBeenCalledTimes(1);
    stream.disconnect();
  });

  it.each(['error', 'close'] as const)(
    'a socket %s before open rejects the first connect',
    async (event) => {
      // Keep setImmediate real so the mock socket's async event fires.
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      mockState.socketOpen = false;
      mockState.socketFailEvent = event;
      const { createStreamClient } = createManagedDingtalkDeps();
      const stream = createStreamClient(SETTINGS, () => true);
      // The rejection must come from the fail event, not the 20s attempt
      // timeout: no fake time is advanced here. The first-connect message is
      // the redacted generic one (the internal reason never escapes).
      await expect(stream.connect()).rejects.toThrow('connect failed');
      stream.disconnect();
    },
  );

  it('closes a socket that opens after the attempt timed out', async () => {
    vi.useFakeTimers();
    mockState.socketOpen = false;
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    const connecting = stream.connect();
    const assertion = expect(connecting).rejects.toThrow('connect failed');
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    const disconnectsBeforeLateOpen = mockState.disconnects;
    // The abandoned attempt's socket opens late; the wrapper must close it so
    // no zombie keeps the heartbeat armed.
    mockState.socket!.readyState = 1;
    mockState.socket!.emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(mockState.disconnects).toBeGreaterThan(disconnectsBeforeLateOpen);
    stream.disconnect();
  });

  it('a successful reconnect re-arms the failure log latch', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // success
    mockState.behavior = 'fail';
    await stream.connect(); // episode 1: logs once
    mockState.behavior = 'ok';
    await stream.connect(); // recovery must reset the latch
    mockState.behavior = 'fail';
    await stream.connect(); // episode 2: must log again
    const reconnectLines = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('reconnect failed'),
    ).length;
    expect(reconnectLines).toBe(2);
    stream.disconnect();
  });

  it('disconnect clears an armed reconnect retry timer', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await stream.connect(); // success
    mockState.behavior = 'fail';
    await stream.connect(); // failure arms the retry
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stream.disconnect();
    // The armed timer must be gone, not merely defused by the stopped flag:
    // a lingering timer would keep the process alive after shutdown.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(mockState.calls).toBe(2);
  });
});

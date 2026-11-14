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
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => {
  class DWClient {
    config = { autoReconnect: true };
    debug = false;
    constructor() {
      mockState.instance = this as unknown as typeof mockState.instance;
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
      if (mockState.connectGate) {
        await mockState.connectGate.promise;
      }
      if (mockState.behavior === 'fail') {
        throw new Error('getEndpoint failed');
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('managed DingTalk stream connect (R1-9)', () => {
  it('the first connect failure propagates — no healthy start on a dead stream', async () => {
    mockState.behavior = 'fail';
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => true);
    await expect(stream.connect()).rejects.toThrow('getEndpoint failed');
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
    vi.useFakeTimers();
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
    vi.useFakeTimers();
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

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  behavior: 'ok' as 'ok' | 'fail',
  calls: 0,
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => {
  class DWClient {
    config = { autoReconnect: true };
    debug = false;
    onDownStream(_data: unknown): void {}
    registerCallbackListener(_topic: unknown, _cb: unknown): void {}
    send(_id: string, _payload: unknown): void {}
    async connect(): Promise<void> {
      mockState.calls += 1;
      if (mockState.behavior === 'fail') {
        throw new Error('getEndpoint failed');
      }
    }
    disconnect(): void {}
  }
  return {
    DWClient,
    TOPIC_ROBOT: 'robot',
    EventAck: { SUCCESS: 'SUCCESS' },
  };
});

import { createManagedDingtalkDeps } from './managed-dingtalk-deps.js';

const SETTINGS = {
  clientId: 'robot-app',
  clientSecret: 'secret',
  pollInterval: 2_000,
};

beforeEach(() => {
  mockState.behavior = 'ok';
  mockState.calls = 0;
});

describe('managed DingTalk stream connect (R1-9)', () => {
  it('the first connect failure propagates — no healthy start on a dead stream', async () => {
    mockState.behavior = 'fail';
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => {});
    await expect(stream.connect()).rejects.toThrow('getEndpoint failed');
  });

  it('a reconnect failure after a successful connect is swallowed', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => {});
    await stream.connect(); // success arms everConnected
    mockState.behavior = 'fail';
    await expect(stream.connect()).resolves.toBeUndefined();
    expect(mockState.calls).toBe(2);
  });

  it('after disconnect a pending connect no-ops instead of reopening a socket', async () => {
    const { createStreamClient } = createManagedDingtalkDeps();
    const stream = createStreamClient(SETTINGS, () => {});
    stream.disconnect();
    await stream.connect();
    expect(mockState.calls).toBe(0);
  });
});

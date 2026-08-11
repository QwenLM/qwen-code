/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUserFrame } from './peer-frames.js';
import { SEND_TIMEOUT_MS, sendPeerFrame } from './uds-client.js';

vi.mock('node:net', () => ({
  connect: vi.fn(),
}));

class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn();
  readonly end = vi.fn();
  private idleTimer: NodeJS.Timeout | undefined;
  private idleCallback: (() => void) | undefined;
  private idleDelay = 0;

  constructor() {
    super();
    this.on('data', () => this.armIdleTimer());
  }

  setTimeout(delay: number, callback: () => void): this {
    this.idleDelay = delay;
    this.idleCallback = callback;
    this.armIdleTimer();
    return this;
  }

  private armIdleTimer(): void {
    if (!this.idleCallback) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(this.idleCallback, this.idleDelay);
  }
}

describe('sendPeerFrame', () => {
  let socket: FakeSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    socket = new FakeSocket();
    vi.mocked(net.connect).mockReturnValue(socket as unknown as net.Socket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('enforces a wall-clock deadline while the peer trickles data', async () => {
    let error: unknown;
    void sendPeerFrame(
      '/tmp/peer.sock',
      buildUserFrame({ content: 'hi' }),
    ).catch((caught: unknown) => {
      error = caught;
    });
    socket.emit('connect');

    for (let elapsed = 0; elapsed < SEND_TIMEOUT_MS; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      socket.emit('data', Buffer.from('x'));
    }

    expect(error).toMatchObject({ code: 'ETIMEDOUT' });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

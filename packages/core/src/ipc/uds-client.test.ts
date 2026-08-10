/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errno mapping for the liveness probe.
 *
 * `uds-inbox.test.ts` covers `probePeerSocket` against real sockets, but
 * a full accept backlog is not reproducible there — Node's server always
 * accepts — so the "busy counts as alive" half of {@link BUSY_PEER_ERRNOS}
 * has to be exercised against a stubbed dial. That half is the
 * load-bearing one: if it regresses, a busy peer drops out of
 * `listMessageablePeers` and the model is told its address is stale.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const connect = vi.fn();
vi.mock('node:net', () => ({
  connect: (...args: unknown[]) => connect(...args),
}));

const { BUSY_PEER_ERRNOS, probePeerSocket, sendPeerFrame, SEND_TIMEOUT_MS } =
  await import('./uds-client.js');
const { buildDeliveryStatusFrame } = await import('./peer-frames.js');

/** A socket that fails the dial with `code` on the next tick. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
  setTimeout() {}
}

function dialFailsWith(code: string | undefined): FakeSocket {
  const socket = new FakeSocket();
  connect.mockImplementation(() => {
    setImmediate(() => {
      const error: NodeJS.ErrnoException = new Error(`dial failed: ${code}`);
      error.code = code;
      socket.emit('error', error);
    });
    return socket;
  });
  return socket;
}

const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\p' : '/tmp/p';

beforeEach(() => {
  connect.mockReset();
});

describe('probePeerSocket errno mapping', () => {
  it.each(BUSY_PEER_ERRNOS)('counts %s as alive', async (code) => {
    const socket = dialFailsWith(code);
    expect(await probePeerSocket(socketPath)).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  // The codes a leftover socket file produces. Reading either as busy
  // would make every orphan look alive and defeat the sweep.
  it.each(['ECONNREFUSED', 'ENOENT', 'EACCES', undefined])(
    'counts %s as dead',
    async (code) => {
      dialFailsWith(code);
      expect(await probePeerSocket(socketPath)).toBe(false);
    },
  );

  it('counts a completed connect as alive', async () => {
    const socket = new FakeSocket();
    connect.mockImplementation(() => {
      setImmediate(() => socket.emit('connect'));
      return socket;
    });
    expect(await probePeerSocket(socketPath)).toBe(true);
  });

  it('never dials a path that is not a local address', async () => {
    expect(await probePeerSocket('relative.sock')).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});

/**
 * A socket that models Node's send timeout faithfully: `setTimeout` on a
 * `net.Socket` is an *idle* timer, and every byte that arrives rearms it.
 * That distinction is the whole point of these two tests — a deadline built
 * on the socket's own timer can be held off indefinitely by a peer that
 * answers, which is exactly what a hostile peer would do.
 */
class IdleTimerSocket extends EventEmitter {
  destroyed = false;
  private idleMs: number | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private onIdle: (() => void) | undefined;

  destroy() {
    this.destroyed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  end() {}

  setTimeout(ms: number, callback: () => void) {
    this.idleMs = ms;
    this.onIdle = callback;
    this.rearm();
  }

  /** One byte from the peer, resetting the idle timer as a real socket does. */
  trickle() {
    this.rearm();
    this.emit('data', 'x');
  }

  private rearm() {
    if (this.idleMs === undefined) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.onIdle?.(), this.idleMs);
  }
}

describe('sendPeerFrame deadline', () => {
  const frame = buildDeliveryStatusFrame({
    status: 'delivered',
    origMsgId: 'm1',
  });

  /** Dial that connects and hands back `socket`, without settling it. */
  function dialConnects(socket: IdleTimerSocket) {
    connect.mockImplementation(() => {
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a peer that trickles data past the deadline', async () => {
    const socket = new IdleTimerSocket();
    dialConnects(socket);

    const outcome = sendPeerFrame(socketPath, frame).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    // 400 ms per byte is well inside the 5 s timeout, so an idle timer is
    // rearmed before it can ever fire. Run to 3x the deadline.
    const trickleMs = 400;
    for (let elapsed = 0; elapsed < SEND_TIMEOUT_MS * 3; elapsed += trickleMs) {
      await vi.advanceTimersByTimeAsync(trickleMs);
      socket.trickle();
    }

    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
    expect(socket.destroyed).toBe(true);
  });

  it('resolves when the peer hangs up before the deadline', async () => {
    const socket = new IdleTimerSocket();
    dialConnects(socket);

    const outcome = sendPeerFrame(socketPath, frame);
    await vi.advanceTimersByTimeAsync(1);
    socket.emit('close');

    await expect(outcome).resolves.toBeUndefined();
    // The deadline must not survive a settled send, or an unref'd timer
    // fires into an already-resolved promise.
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS * 2);
    expect(socket.destroyed).toBe(false);
  });
});

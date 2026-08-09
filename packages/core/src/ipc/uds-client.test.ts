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
import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn();
vi.mock('node:net', () => ({
  connect: (...args: unknown[]) => connect(...args),
}));

const { BUSY_PEER_ERRNOS, probePeerSocket } = await import('./uds-client.js');

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

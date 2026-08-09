/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errno classification for `probePeerSocket`.
 *
 * The real-socket coverage lives in `uds-inbox.test.ts`; what cannot be
 * provoked there is a *full listen backlog*, because filling one requires
 * a server whose event loop is blocked while that same loop dials it. The
 * classification is the whole point of the helper — a wrong verdict here
 * sweeps a live session — so the dial is faked to hand it each errno
 * directly.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<EventEmitter & { destroyed: boolean }>,
}));

vi.mock('node:net', () => ({
  connect: () => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        socket.destroyed = true;
      },
      setTimeout(_ms: number, _cb: () => void) {},
    });
    sockets.push(socket);
    return socket;
  },
}));

const { probePeerSocket } = await import('./uds-client.js');

// `node:net` is mocked, but `isLocalIpcPath` is not: it gates every dial and
// accepts only named pipes on win32. A POSIX path here would make
// `probePeerSocket` return false without dialing, turning the whole suite red
// on the `test_windows` merge gate for reasons unrelated to classification.
const PROBE_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\qwen-probe'
    : '/tmp/qwen-probe/a.sock';

afterEach(() => {
  sockets.length = 0;
});

/** Dials, then fails the dial with `code`, and reports the verdict. */
function probeWithErrno(code: string): Promise<boolean> {
  const verdict = probePeerSocket(PROBE_PATH);
  const socket = sockets.at(-1);
  if (!socket) throw new Error('probePeerSocket did not dial');
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  socket.emit('error', error);
  return verdict;
}

describe('probePeerSocket errno classification', () => {
  // On Linux, connecting to a UNIX socket whose accept queue is full
  // fails with EAGAIN, not EBUSY. Keying on EBUSY alone reports every
  // congested-but-alive Linux peer as dead.
  it.each(['EBUSY', 'EAGAIN'])(
    'reports a peer alive when the dial fails with %s',
    async (code) => {
      expect(await probeWithErrno(code)).toBe(true);
    },
  );

  it.each(['ENOENT', 'ECONNREFUSED', 'EACCES'])(
    'reports a peer dead when the dial fails with %s',
    async (code) => {
      expect(await probeWithErrno(code)).toBe(false);
    },
  );

  it('reports a peer alive when the dial connects', async () => {
    const verdict = probePeerSocket(PROBE_PATH);
    sockets.at(-1)?.emit('connect');
    expect(await verdict).toBe(true);
  });

  it('destroys the socket on every outcome', async () => {
    await probeWithErrno('EAGAIN');
    expect(sockets.at(-1)?.destroyed).toBe(true);
  });
});

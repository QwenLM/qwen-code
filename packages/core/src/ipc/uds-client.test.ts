/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `probePeerSocket` against a real socket for the reachable/stale cases,
 * and against a scripted `net.connect` for the errno and deadline rules
 * that a real socket cannot be made to produce on demand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type ConnectImpl = (...args: unknown[]) => unknown;
let connectImpl: ConnectImpl | null = null;
const connectCalls: unknown[][] = [];

vi.mock('node:net', async () => {
  const real = await vi.importActual<typeof import('node:net')>('node:net');
  const connect = (...args: unknown[]) => {
    connectCalls.push(args);
    return connectImpl
      ? connectImpl(...args)
      : (real.connect as ConnectImpl)(...args);
  };
  return { ...real, default: { ...real, connect }, connect };
});

const { probePeerSocket, PROBE_TIMEOUT_MS } = await import('./uds-client.js');
const { startPeerInbox } = await import('./uds-inbox.js');

const isWindows = process.platform === 'win32';

/** A socket that never connects; the test scripts what it emits. */
function scriptedSocket(): EventEmitter & { destroy: () => void } {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
  socket.destroy = vi.fn();
  return socket;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-probe-'));
  connectImpl = null;
  connectCalls.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(isWindows)('probePeerSocket', () => {
  it('is true for a socket something is listening on', async () => {
    const inbox = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'live.sock'),
      onFrame: () => {},
    });
    if (!inbox) throw new Error('inbox failed to start');
    try {
      expect(await probePeerSocket(inbox.socketPath)).toBe(true);
    } finally {
      await inbox.close();
    }
  });

  it('is false for an address nothing listens on', async () => {
    expect(await probePeerSocket(path.join(tmpDir, 'gone.sock'))).toBe(false);
  });

  it('is false for a stale socket file left by a dead process', async () => {
    // A leftover inode stats fine; only the dial (ECONNREFUSED) says it is dead.
    const stale = path.join(tmpDir, 'stale.sock');
    await fs.writeFile(stale, '');
    expect(await probePeerSocket(stale)).toBe(false);
  });

  it('refuses to dial a non-local path', async () => {
    expect(await probePeerSocket('relative/peer.sock')).toBe(false);
    expect(await probePeerSocket('//host/share/peer.sock')).toBe(false);
    expect(connectCalls).toHaveLength(0);
  });

  it('counts a full listen backlog as alive, and every other errno as dead', async () => {
    const probeWithError = async (code: string) => {
      const socket = scriptedSocket();
      connectImpl = () => {
        queueMicrotask(() =>
          socket.emit('error', Object.assign(new Error(code), { code })),
        );
        return socket;
      };
      return probePeerSocket('/tmp/scripted.sock');
    };
    expect(await probeWithError('EAGAIN')).toBe(true);
    expect(await probeWithError('EBUSY')).toBe(true);
    expect(await probeWithError('ECONNREFUSED')).toBe(false);
    expect(await probeWithError('ENOENT')).toBe(false);
    expect(await probeWithError('EACCES')).toBe(false);
  });

  it('gives up after PROBE_TIMEOUT_MS when the listener never accepts', async () => {
    vi.useFakeTimers();
    const socket = scriptedSocket();
    connectImpl = () => socket;
    let settled: boolean | null = null;
    void probePeerSocket('/tmp/hung.sock').then((alive) => {
      settled = alive;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(socket.destroy).toHaveBeenCalled();
  });
});

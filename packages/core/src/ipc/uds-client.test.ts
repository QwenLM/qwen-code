/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `probePeerSocket` against a real socket for the reachable/stale cases,
 * and against a scripted `net.connect` for the errno and deadline rules
 * that a real socket cannot be made to produce on demand.
 *
 * The verdict suite below carries the three-valued answer; the boolean
 * suite carries the collapse the read-only listing consumes. They are kept
 * apart because the interesting cases are exactly the ones where the two
 * disagree -- `unknown` and `dead` both read as `false`.
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

const { probePeerSocket, probePeerSocketVerdict, PROBE_TIMEOUT_MS } =
  await import('./uds-client.js');
const { startPeerInbox } = await import('./uds-inbox.js');

const isWindows = process.platform === 'win32';

/** A socket that never connects; the test scripts what it emits. */
function scriptedSocket(): EventEmitter & { destroy: () => void } {
  const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
  socket.destroy = vi.fn();
  return socket;
}

/** Drive one `connect` failure through the probe, for errnos a real
 * socket cannot be made to produce on demand. */
function scriptErrno(code: string): void {
  const socket = scriptedSocket();
  connectImpl = () => {
    queueMicrotask(() =>
      socket.emit('error', Object.assign(new Error(code), { code })),
    );
    return socket;
  };
}

async function probeVerdictWithError(code: string) {
  scriptErrno(code);
  return probePeerSocketVerdict('/tmp/scripted.sock');
}

async function probeBooleanWithError(code: string) {
  scriptErrno(code);
  return probePeerSocket('/tmp/scripted.sock');
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

  it('is false for every answer short of a listener, conclusive or not', async () => {
    // The collapse this consumer wants: only `alive` advertises a peer as
    // messageable, so an inconclusive probe reads the same as a dead one.
    expect(await probeBooleanWithError('EAGAIN')).toBe(true);
    expect(await probeBooleanWithError('EMFILE')).toBe(false);
    expect(await probeBooleanWithError('ECONNREFUSED')).toBe(false);
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

describe.skipIf(isWindows)('probePeerSocketVerdict', () => {
  it('is alive only when a listener answers or the backlog is full', async () => {
    const inbox = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'live.sock'),
      onFrame: () => {},
    });
    if (!inbox) throw new Error('inbox failed to start');
    try {
      expect(await probePeerSocketVerdict(inbox.socketPath)).toBe('alive');
    } finally {
      await inbox.close();
    }
    // A saturated listen backlog is a busy session, not a dead one.
    expect(await probeVerdictWithError('EAGAIN')).toBe('alive');
    expect(await probeVerdictWithError('EBUSY')).toBe('alive');
  });

  it('is dead only when the dial reached the path and found nothing', async () => {
    expect(await probePeerSocketVerdict(path.join(tmpDir, 'gone.sock'))).toBe(
      'dead',
    );
    // A leftover inode stats fine; only the dial (ECONNREFUSED) says it is
    // dead, and this is the one verdict that licenses an unlink.
    const stale = path.join(tmpDir, 'stale.sock');
    await fs.writeFile(stale, '');
    expect(await probePeerSocketVerdict(stale)).toBe('dead');
  });

  it('is unknown when the probe establishes nothing about the peer', async () => {
    // Descriptor exhaustion and permission errors are about this process,
    // not the peer; an unenumerated errno has not been reasoned about at
    // all. None of them may be spent as proof of death.
    expect(await probeVerdictWithError('EMFILE')).toBe('unknown');
    expect(await probeVerdictWithError('ENFILE')).toBe('unknown');
    expect(await probeVerdictWithError('EACCES')).toBe('unknown');
    expect(await probeVerdictWithError('EPERM')).toBe('unknown');
    expect(await probeVerdictWithError('EPROTOTYPE')).toBe('unknown');
    // Nothing was dialled at all here, so nothing was established.
    expect(await probePeerSocketVerdict('relative/peer.sock')).toBe('unknown');
  });

  it('is unknown, not dead, when the deadline wins', async () => {
    // The case the sweep turns on: a slow peer and a stalled prober are
    // indistinguishable from here, so the timeout must not delete anything.
    vi.useFakeTimers();
    const socket = scriptedSocket();
    connectImpl = () => socket;
    let settled: string | null = null;
    void probePeerSocketVerdict('/tmp/hung.sock').then((verdict) => {
      settled = verdict;
    });
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(settled).toBe('unknown');
  });
});

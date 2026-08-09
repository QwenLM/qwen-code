/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import {
  isPidAlive,
  isSameProcess,
  PID_NAMESPACE_UNREADABLE,
  readMachineId,
  readPidNamespaceId,
  readProcStartToken,
} from './process-liveness.js';

/**
 * Lets a single test make the `/proc/<pid>/stat` read fail. Everything
 * else passes straight through to the real `node:fs`.
 */
const procReadFails = vi.hoisted(() => ({ value: false }));

/** The same, for the `/proc/self/ns/pid` readlink. */
const nsReadFails = vi.hoisted(() => ({ value: false }));

/** Serves a chosen `/proc/self/ns/pid` target instead of the real one. */
const nsLinkTarget = vi.hoisted(() => ({ value: null as string | null }));

/**
 * Stands in for the machine-id sources, which cannot be arranged on the
 * real filesystem: a path present here is served from the map (a string
 * is the file's contents, `null` means ENOENT), anything absent falls
 * through to the real `node:fs`.
 */
const machineIdFiles = vi.hoisted(() => new Map<string, string | null>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: ((...args: unknown[]) => {
      if (typeof args[0] === 'string' && machineIdFiles.has(args[0])) {
        const contents = machineIdFiles.get(args[0]);
        if (contents === null) {
          throw Object.assign(
            new Error(`ENOENT: no such file, open '${args[0]}'`),
            { code: 'ENOENT' },
          );
        }
        return contents;
      }
      if (procReadFails.value) {
        throw Object.assign(new Error('EACCES: /proc unreadable'), {
          code: 'EACCES',
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(...args);
    }) as typeof actual.readFileSync,
    readlinkSync: ((...args: unknown[]) => {
      if (nsReadFails.value) {
        throw Object.assign(new Error('EACCES: /proc unreadable'), {
          code: 'EACCES',
        });
      }
      if (nsLinkTarget.value !== null && args[0] === '/proc/self/ns/pid') {
        return nsLinkTarget.value;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readlinkSync as any)(...args);
    }) as typeof actual.readlinkSync,
  };
});

/** A PID that is essentially certain not to be running. */
const DEAD_PID = 0x7ffffffe;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Starts a child that idles until it is killed, resolving once it is
 * actually spawned so `/proc/<pid>/stat` is readable.
 */
function spawnSleeper(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60_000)'],
    {
      stdio: 'ignore',
    },
  );
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('reports an unused pid as dead', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });

  it('rejects nonsense pids without throwing', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

describe('readProcStartToken', () => {
  it('returns a numeric token for a live process on Linux', () => {
    const token = readProcStartToken(process.pid);
    if (process.platform !== 'linux') {
      expect(token).toBeNull();
      return;
    }
    expect(token).toMatch(/^\d+$/);
  });

  it('is stable across calls', () => {
    expect(readProcStartToken(process.pid)).toBe(
      readProcStartToken(process.pid),
    );
  });

  it('returns null for a dead pid', () => {
    expect(readProcStartToken(DEAD_PID)).toBeNull();
  });

  it('grows with start order, so a later process reads a larger token', async () => {
    if (process.platform !== 'linux') return;
    // Pins the *field index*, which every other assertion here tolerates
    // being wrong: `starttime`'s neighbours in /proc/<pid>/stat are
    // `itrealvalue` (hardcoded 0 on modern kernels) and `vsize` (equal for
    // two copies of the same binary), and a constant cannot be strictly
    // increasing. Without this, an off-by-one edit hands every process the
    // same token, `isSameProcess` stops detecting PID recycling, and dead
    // sessions resurrect under a reused PID.
    //
    // /proc reports `starttime` in clock ticks at a fixed USER_HZ of 100,
    // i.e. 10ms per tick, so the gap below is several ticks wide.
    const first = await spawnSleeper();
    try {
      await delay(80);
      const second = await spawnSleeper();
      try {
        const firstToken = readProcStartToken(first.pid!);
        const secondToken = readProcStartToken(second.pid!);
        expect(firstToken).toMatch(/^\d+$/);
        expect(secondToken).toMatch(/^\d+$/);
        expect(Number(secondToken)).toBeGreaterThan(Number(firstToken));
      } finally {
        second.kill('SIGKILL');
      }
    } finally {
      first.kill('SIGKILL');
    }
  });
});

describe('isSameProcess', () => {
  it('is false for a dead pid regardless of token', () => {
    expect(isSameProcess(DEAD_PID, null)).toBe(false);
    expect(isSameProcess(DEAD_PID, '123')).toBe(false);
  });

  it('accepts a live pid recorded without a token', () => {
    expect(isSameProcess(process.pid, null)).toBe(true);
    expect(isSameProcess(process.pid, undefined)).toBe(true);
  });

  it('accepts a live pid whose token still matches', () => {
    const token = readProcStartToken(process.pid);
    expect(isSameProcess(process.pid, token)).toBe(true);
  });

  it('rejects a live pid whose token has changed', () => {
    if (process.platform !== 'linux') return;
    expect(isSameProcess(process.pid, 'definitely-not-the-token')).toBe(false);
  });

  it('keeps a live pid when the current token cannot be read', () => {
    // The degrade branch: /proc went unreadable between the two reads, or
    // the platform never exposed a token at all. Liveness alone has to
    // win here — inverting this sweeps a live session's record on every
    // platform without /proc, which is the failure the module exists to
    // avoid. Nothing else covers it: the recorded-token tests are
    // Linux-guarded, and on Linux a live pid always reads back a token.
    procReadFails.value = true;
    try {
      expect(readProcStartToken(process.pid)).toBeNull();
      expect(isSameProcess(process.pid, '123')).toBe(true);
    } finally {
      procReadFails.value = false;
    }
  });
});

describe('readPidNamespaceId', () => {
  it('reads a stable inode on Linux and null everywhere else', () => {
    const id = readPidNamespaceId();
    if (process.platform === 'linux') {
      // `/proc/self/ns/pid` reads `pid:[<inode>]`; only the inode is
      // returned, and a process cannot change namespace under itself, so
      // two reads in one process must agree.
      expect(id).toMatch(/^\d+$/);
      expect(readPidNamespaceId()).toBe(id);
    } else {
      expect(id).toBeNull();
    }
  });

  it('agrees with the namespace this process actually reports', () => {
    if (process.platform !== 'linux') return;
    // Anchored against the real symlink rather than a second call to the
    // function under test: a regression that returned a constant, or read
    // the wrong ns entry, would otherwise stay green above.
    const target = readlinkSync('/proc/self/ns/pid');
    expect(target).toBe(`pid:[${readPidNamespaceId()}]`);
    // The mount namespace is a different entry with the same shape, so a
    // typo'd path is a live failure mode worth pinning against.
    expect(target).not.toBe(readlinkSync('/proc/self/ns/mnt'));
  });

  it('reports an unreadable link as unprovable, not as "no namespaces"', () => {
    nsReadFails.value = true;
    try {
      // Specifically NOT null. null is the claim "this platform has no PID
      // namespaces", which two peers can legitimately agree on; an
      // unreadable `/proc/self/ns/pid` is the absence of any claim. Two
      // containers behind a hidepid mount that shared a machine id and a
      // QWEN_HOME would otherwise match as one origin and read each
      // other's PID numbers as their own.
      expect(readPidNamespaceId()).toBe(PID_NAMESPACE_UNREADABLE);
      expect(readPidNamespaceId()).not.toBeNull();
    } finally {
      nsReadFails.value = false;
    }
  });

  it('reports a link whose target does not parse as unprovable too', () => {
    nsLinkTarget.value = 'pid:[not-an-inode]';
    try {
      expect(readPidNamespaceId()).toBe(PID_NAMESPACE_UNREADABLE);
    } finally {
      nsLinkTarget.value = null;
    }
  });
});

describe('readMachineId', () => {
  const ETC = '/etc/machine-id';
  const DBUS = '/var/lib/dbus/machine-id';

  afterEach(() => {
    machineIdFiles.clear();
  });

  it('returns the committed id from /etc/machine-id', () => {
    machineIdFiles.set(ETC, 'd2f0e4b1c3a54e6f8a9b0c1d2e3f4a5b\n');
    expect(readMachineId()).toBe('d2f0e4b1c3a54e6f8a9b0c1d2e3f4a5b');
  });

  it("does not accept systemd's 'uninitialized' sentinel as an identity", () => {
    // OSTree/CoreOS images and any host before `machine-id-setup --commit`
    // ship this readable, non-empty file. Accepting it makes every such
    // host report one machineId, so their origin gates open to each other
    // and one host's sweep unlinks the other's live session records.
    machineIdFiles.set(ETC, 'uninitialized\n');
    machineIdFiles.set(DBUS, null);
    expect(readMachineId()).not.toBe('uninitialized');
    expect(readMachineId()).toBe(hostname().trim());
  });

  it('falls through the sentinel to the dbus copy when that one is committed', () => {
    machineIdFiles.set(ETC, 'uninitialized\n');
    machineIdFiles.set(DBUS, 'ab12cd34ef56ab78cd90ef12ab34cd56\n');
    expect(readMachineId()).toBe('ab12cd34ef56ab78cd90ef12ab34cd56');
  });

  it('does not accept the all-zero id as an identity', () => {
    // `machine-id(5)`: "This ID may not be all zeros." It is the legacy,
    // pre-sentinel form of the same uncommitted state — same consequence,
    // one machineId shared by every host in it.
    machineIdFiles.set(ETC, `${'0'.repeat(32)}\n`);
    machineIdFiles.set(DBUS, null);
    expect(readMachineId()).toBe(hostname().trim());
  });

  it('falls through the all-zero id to the dbus copy when that one is committed', () => {
    machineIdFiles.set(ETC, `${'0'.repeat(32)}\n`);
    machineIdFiles.set(DBUS, 'ab12cd34ef56ab78cd90ef12ab34cd56\n');
    expect(readMachineId()).toBe('ab12cd34ef56ab78cd90ef12ab34cd56');
  });

  it('falls back to the hostname when no source is readable', () => {
    machineIdFiles.set(ETC, null);
    machineIdFiles.set(DBUS, null);
    expect(readMachineId()).toBe(hostname().trim());
  });

  it('treats an empty file the same as a missing one', () => {
    machineIdFiles.set(ETC, '\n');
    machineIdFiles.set(DBUS, null);
    expect(readMachineId()).toBe(hostname().trim());
  });
});

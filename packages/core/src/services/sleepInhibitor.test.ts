/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { acquireSleepInhibitor, SleepInhibitor } from './sleepInhibitor.js';

function createChild(pid: number | undefined = 4242): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;
  Object.defineProperty(child, 'killed', {
    get: () => killed,
  });
  // A real successful spawn has a numeric pid synchronously; a failed spawn
  // (e.g. ENOENT) leaves it undefined. Tests pass `undefined` to model that.
  child.pid = pid;
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

function createHarness(platform: NodeJS.Platform = 'linux') {
  const children: ChildProcess[] = [];
  const spawn = vi.fn(
    (_command: string, _args: string[], _options?: SpawnOptions) => {
      const child = createChild();
      children.push(child);
      return child;
    },
  );
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };
  const inhibitor = new SleepInhibitor({ platform, spawn, logger });
  return { children, inhibitor, logger, spawn };
}

describe('SleepInhibitor', () => {
  it('starts systemd-inhibit on linux and stops it after the final release', () => {
    const { children, inhibitor, spawn } = createHarness('linux');

    const first = inhibitor.acquire('working');
    const second = inhibitor.acquire('working again');

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      [
        '--what=sleep',
        '--who=Qwen Code',
        '--why=working',
        '--mode=block',
        'sleep',
        'infinity',
      ],
      expect.objectContaining({
        env: expect.any(Object),
        stdio: 'ignore',
        windowsHide: true,
      }),
    );
    expect(inhibitor.getActiveCount()).toBe(2);

    first.release();
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(inhibitor.isRunning()).toBe(true);

    second.release();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(inhibitor.getActiveCount()).toBe(0);
    expect(inhibitor.isRunning()).toBe(false);
  });

  it('forwards a curated environment instead of an empty env', () => {
    const { inhibitor, spawn } = createHarness('linux');
    const previous = process.env['DBUS_SESSION_BUS_ADDRESS'];
    process.env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus';
    try {
      const handle = inhibitor.acquire();
      const env = spawn.mock.calls[0]![2]!.env as NodeJS.ProcessEnv;
      // D-Bus address required by systemd-inhibit must be forwarded.
      expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe(
        'unix:path=/run/user/1000/bus',
      );
      // Arbitrary parent env vars must NOT be forwarded.
      expect(env).not.toHaveProperty('SOME_UNRELATED_SECRET');
      handle.release();
    } finally {
      if (previous === undefined) {
        delete process.env['DBUS_SESSION_BUS_ADDRESS'];
      } else {
        process.env['DBUS_SESSION_BUS_ADDRESS'] = previous;
      }
    }
  });

  it('uses caffeinate on macOS', () => {
    const { inhibitor, spawn } = createHarness('darwin');

    const handle = inhibitor.acquire();

    expect(spawn).toHaveBeenCalledWith(
      'caffeinate',
      ['-is'],
      expect.any(Object),
    );
    handle.release();
  });

  it('uses a PowerShell SetThreadExecutionState helper on Windows', () => {
    const { inhibitor, spawn } = createHarness('win32');

    const handle = inhibitor.acquire();

    expect(spawn).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        expect.stringContaining('SetThreadExecutionState'),
      ]),
      expect.any(Object),
    );
    handle.release();
  });

  it('ignores duplicate releases', () => {
    const { children, inhibitor } = createHarness('linux');

    const handle = inhibitor.acquire();
    handle.release();
    handle.release();

    expect(inhibitor.getActiveCount()).toBe(0);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('fails open when spawning throws', () => {
    const spawn = vi.fn(() => {
      throw new Error('missing command');
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const inhibitor = new SleepInhibitor({
      platform: 'linux',
      spawn,
      logger,
    });

    const handle = inhibitor.acquire();

    expect(() => handle.release()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to spawn sleep inhibitor: missing command',
    );
    expect(inhibitor.getActiveCount()).toBe(0);
  });

  it('handles async error events from the spawned child', () => {
    const { children, inhibitor, logger } = createHarness('linux');

    const handle = inhibitor.acquire();
    children[0]!.emit('error', new Error('EPERM'));

    expect(inhibitor.isRunning()).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to start sleep inhibitor: EPERM',
    );
    handle.release();
  });

  it('restarts after an unexpected exit when acquired again', () => {
    const { children, inhibitor, logger, spawn } = createHarness('linux');

    const first = inhibitor.acquire('initial work');
    children[0]!.emit('exit', 1, null);

    expect(inhibitor.isRunning()).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      'Sleep inhibitor exited while active: code=1 signal=null',
    );

    const second = inhibitor.acquire('more work');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(inhibitor.isRunning()).toBe(true);

    first.release();
    second.release();
  });

  it('returns a no-op handle when config does not explicitly enable it', () => {
    const disabled = acquireSleepInhibitor({
      getPreventSystemSleepEnabled: () => false,
    });
    const missingGetter = acquireSleepInhibitor(
      {} as {
        getPreventSystemSleepEnabled: () => boolean;
      },
    );

    expect(() => disabled.release()).not.toThrow();
    expect(() => missingGetter.release()).not.toThrow();
  });

  it('dispose kills the active child, resets state, and is idempotent', () => {
    const { children, inhibitor } = createHarness('linux');

    inhibitor.acquire('work');
    inhibitor.acquire('more work');
    expect(inhibitor.getActiveCount()).toBe(2);
    expect(inhibitor.isRunning()).toBe(true);

    inhibitor.dispose();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(inhibitor.getActiveCount()).toBe(0);
    expect(inhibitor.isRunning()).toBe(false);

    // Second dispose is a no-op and must not throw or re-kill.
    expect(() => inhibitor.dispose()).not.toThrow();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('does not propagate when child.kill() throws during release', () => {
    const children: ChildProcess[] = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, 'killed', { get: () => false });
      child.pid = 4242;
      child.kill = vi.fn(() => {
        throw new Error('ESRCH');
      });
      children.push(child);
      return child;
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const inhibitor = new SleepInhibitor({ platform: 'linux', spawn, logger });

    const handle = inhibitor.acquire();
    expect(() => handle.release()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to stop sleep inhibitor: ESRCH',
    );
    expect(inhibitor.getActiveCount()).toBe(0);
  });

  it('does not kill a child whose spawn failed (no pid)', () => {
    // Mimics the container sandbox: `systemd-inhibit` is absent, so the spawn
    // rejects with ENOENT on the next tick and the child never gets a pid. If
    // `stop()` (here via the synchronous release before the error event fires)
    // called `kill()` on this pidless child, the kill would target the
    // caller's own process group and deliver SIGTERM to this process, aborting
    // the run. Releasing must therefore be a no-op for a pidless child.
    const children: ChildProcess[] = [];
    const spawn = vi.fn(() => {
      // Pidless child: spawn returned but the process never started (ENOENT).
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, 'killed', { get: () => false });
      child.pid = undefined;
      child.kill = vi.fn(() => true);
      children.push(child);
      return child;
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const inhibitor = new SleepInhibitor({ platform: 'linux', spawn, logger });

    const handle = inhibitor.acquire('executing tool');
    expect(spawn).toHaveBeenCalledTimes(1);

    handle.release();

    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(inhibitor.getActiveCount()).toBe(0);
    expect(inhibitor.isRunning()).toBe(false);
  });

  it('ignores a late error event from an already-replaced child', () => {
    const { children, inhibitor, logger, spawn } = createHarness('linux');

    const first = inhibitor.acquire();
    // First child exits, so this.child is cleared and a re-acquire respawns.
    children[0]!.emit('exit', 0, null);
    const second = inhibitor.acquire();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(inhibitor.isRunning()).toBe(true);

    logger.debug.mockClear();
    // A late error from the stale first child must be ignored: it must not
    // flip spawnFailedForCurrentRun nor clear the current (second) child.
    children[0]!.emit('error', new Error('ESRCH'));
    expect(logger.debug).not.toHaveBeenCalledWith(
      'Failed to start sleep inhibitor: ESRCH',
    );
    expect(inhibitor.isRunning()).toBe(true);

    first.release();
    second.release();
  });

  it('latches on an unsupported platform so it only checks once', () => {
    const { inhibitor, logger, spawn } = createHarness(
      'freebsd' as NodeJS.Platform,
    );

    const first = inhibitor.acquire();
    const second = inhibitor.acquire();

    expect(spawn).not.toHaveBeenCalled();
    expect(inhibitor.isRunning()).toBe(false);
    expect(
      logger.debug.mock.calls.filter((call) =>
        String(call[0]).includes('unsupported on platform'),
      ),
    ).toHaveLength(1);

    first.release();
    second.release();
  });

  it('sanitizes the systemd-inhibit reason (strips control chars, caps length)', () => {
    const { inhibitor, spawn } = createHarness('linux');

    const handle = inhibitor.acquire(`run\x00 tool\n${'x'.repeat(200)}`);
    const args = spawn.mock.calls[0]![1] as string[];
    const why = args.find((arg) => arg.startsWith('--why='))!;

    // eslint-disable-next-line no-control-regex
    expect(why).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(why.length).toBeLessThanOrEqual('--why='.length + 120);

    handle.release();
  });
});

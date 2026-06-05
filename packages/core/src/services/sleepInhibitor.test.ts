/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { acquireSleepInhibitor, SleepInhibitor } from './sleepInhibitor.js';

function createChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;
  Object.defineProperty(child, 'killed', {
    get: () => killed,
  });
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
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { acquireSleepInhibitor, SleepInhibitor } from './sleepInhibitor.js';
import { PassThrough } from 'node:stream';

function createChild(pid: number | undefined = 4242): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  let killed = false;
  Object.defineProperty(child, 'killed', {
    get: () => killed,
  });
  // A real successful spawn has a numeric pid synchronously; a failed spawn
  // (e.g. ENOENT) leaves it undefined. Tests pass `undefined` to model that.
  // `pid` is readonly on ChildProcess, so define it rather than assign.
  Object.defineProperty(child, 'pid', { value: pid });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

function createHelpChild(output: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperty(child, 'stdout', { value: stdout });
  Object.defineProperty(child, 'stderr', { value: stderr });
  Object.defineProperty(child, 'pid', { value: 9999 });
  Object.defineProperty(child, 'killed', { value: false });
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    stdout.write(output);
    stdout.end();
    child.emit('close', 0, null);
  });
  return child;
}

function createErrorChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: undefined });
  Object.defineProperty(child, 'killed', { value: false });
  child.kill = vi.fn(() => true);
  queueMicrotask(() => child.emit('error', new Error('ENOENT')));
  return child;
}

function createHarness(
  platform: NodeJS.Platform = 'linux',
  env: NodeJS.ProcessEnv = {},
  noAskPasswordSupported: boolean | null = true,
) {
  const children: ChildProcess[] = [];
  const helpOutput = noAskPasswordSupported
    ? 'systemd-inhibit [OPTIONS...] COMMAND ...\n\n  --no-ask-password    Do not attempt interactive authorization\n'
    : 'systemd-inhibit [OPTIONS...] COMMAND ...\n\n  --what=WHAT          Operations to inhibit\n';
  const spawn = vi.fn(
    (command: string, args: string[], _options?: SpawnOptions) => {
      if (command === 'systemd-inhibit' && args[0] === '--help') {
        if (noAskPasswordSupported === null) {
          return createErrorChild();
        }
        return createHelpChild(helpOutput);
      }
      const child = createChild();
      children.push(child);
      return child;
    },
  );
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
  };
  const inhibitor = new SleepInhibitor({ platform, env, spawn, logger });
  return { children, inhibitor, logger, spawn };
}

describe('SleepInhibitor', () => {
  it('starts systemd-inhibit on linux and stops it after the final release', async () => {
    const { children, inhibitor, spawn } = createHarness('linux');

    const first = inhibitor.acquire('working');
    const second = inhibitor.acquire('working again');

    // Initially only the --help probe is spawned
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toBe('systemd-inhibit');
    expect(spawn.mock.calls[0]![1]).toEqual(['--help']);

    // After probe completes, the real inhibitor spawns
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      [
        '--no-ask-password',
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

  it('skips systemd-inhibit for headless SSH sessions on Linux', () => {
    const { inhibitor, logger, spawn } = createHarness('linux', {
      SSH_CONNECTION: '10.0.0.1 55555 10.0.0.2 22',
    });

    const first = inhibitor.acquire('working over SSH');
    const second = inhibitor.acquire('more SSH work');

    expect(spawn).not.toHaveBeenCalled();
    expect(inhibitor.isRunning()).toBe(false);
    expect(inhibitor.getActiveCount()).toBe(2);
    expect(logger.debug).toHaveBeenCalledWith(
      'Sleep inhibition skipped for headless SSH session.',
    );
    expect(logger.debug).toHaveBeenCalledTimes(1);

    first.release();
    second.release();
    expect(inhibitor.getActiveCount()).toBe(0);
  });

  it('starts systemd-inhibit for SSH sessions with a display server', async () => {
    const { inhibitor, spawn } = createHarness('linux', {
      SSH_TTY: '/dev/pts/3',
      DISPLAY: ':10',
    });

    const handle = inhibitor.acquire('forwarded display work');

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      expect.arrayContaining(['--what=sleep']),
      expect.any(Object),
    );
    handle.release();
  });

  it('starts systemd-inhibit for local headless Linux sessions', async () => {
    const { inhibitor, spawn } = createHarness('linux');

    const handle = inhibitor.acquire('local headless work');

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    expect(spawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      expect.arrayContaining(['--what=sleep']),
      expect.any(Object),
    );
    handle.release();
  });

  it('forwards a curated environment instead of an empty env', async () => {
    const { inhibitor, spawn } = createHarness('linux', {
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SOME_UNRELATED_SECRET: 'secret',
    });

    const handle = inhibitor.acquire();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    const env = spawn.mock.calls[1]![2]!.env as NodeJS.ProcessEnv;
    // D-Bus address required by systemd-inhibit must be forwarded.
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe(
      'unix:path=/run/user/1000/bus',
    );
    // Arbitrary parent env vars must NOT be forwarded.
    expect(env).not.toHaveProperty('SOME_UNRELATED_SECRET');
    handle.release();
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

  it('ignores duplicate releases', async () => {
    const { children, inhibitor } = createHarness('linux');

    const handle = inhibitor.acquire();
    await vi.waitFor(() => expect(inhibitor.isRunning()).toBe(true));
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
      env: {},
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

  it('handles async error events from the spawned child', async () => {
    const { children, inhibitor, logger } = createHarness('linux');

    const handle = inhibitor.acquire();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit('error', new Error('EPERM'));

    expect(inhibitor.isRunning()).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to start sleep inhibitor: EPERM',
    );
    handle.release();
  });

  it('restarts after an unexpected exit when acquired again', async () => {
    const { children, inhibitor, logger, spawn } = createHarness('linux');

    const first = inhibitor.acquire('initial work');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit('exit', 1, null);

    expect(inhibitor.isRunning()).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      'Sleep inhibitor exited while active: code=1 signal=null',
    );

    const second = inhibitor.acquire('more work');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
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

  it('dispose kills the active child, resets state, and is idempotent', async () => {
    const { children, inhibitor } = createHarness('linux');

    inhibitor.acquire('work');
    inhibitor.acquire('more work');
    await vi.waitFor(() => expect(inhibitor.isRunning()).toBe(true));
    expect(inhibitor.getActiveCount()).toBe(2);

    inhibitor.dispose();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(inhibitor.getActiveCount()).toBe(0);
    expect(inhibitor.isRunning()).toBe(false);

    // Second dispose is a no-op and must not throw or re-kill.
    expect(() => inhibitor.dispose()).not.toThrow();
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it('does not propagate when child.kill() throws during release', async () => {
    const children: ChildProcess[] = [];
    const spawn = vi.fn((command: string, args: string[]) => {
      if (command === 'systemd-inhibit' && args[0] === '--help') {
        return createHelpChild('--no-ask-password');
      }
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, 'killed', { get: () => false });
      Object.defineProperty(child, 'pid', { value: 4242 });
      child.kill = vi.fn(() => {
        throw new Error('ESRCH');
      });
      children.push(child);
      return child;
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const inhibitor = new SleepInhibitor({
      platform: 'linux',
      env: {},
      spawn,
      logger,
    });

    const handle = inhibitor.acquire();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(() => handle.release()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to stop sleep inhibitor: ESRCH',
    );
    expect(inhibitor.getActiveCount()).toBe(0);
  });

  it('does not kill a child whose spawn failed (no pid)', async () => {
    // Mimics the container sandbox: `systemd-inhibit` is absent, so the spawn
    // rejects with ENOENT on the next tick and the child never gets a pid. If
    // `stop()` (here via the synchronous release before the error event fires)
    // called `kill()` on this pidless child, the kill would target the
    // caller's own process group and deliver SIGTERM to this process, aborting
    // the run. Releasing must therefore be a no-op for a pidless child.
    const children: ChildProcess[] = [];
    const spawn = vi.fn((command: string, args: string[]) => {
      if (command === 'systemd-inhibit' && args[0] === '--help') {
        return createErrorChild();
      }
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperty(child, 'killed', { get: () => false });
      // Pidless child: spawn returned but the process never started (ENOENT).
      Object.defineProperty(child, 'pid', { value: undefined });
      child.kill = vi.fn(() => true);
      children.push(child);
      return child;
    });
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const inhibitor = new SleepInhibitor({
      platform: 'linux',
      env: {},
      spawn,
      logger,
    });

    const handle = inhibitor.acquire('executing tool');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

    handle.release();

    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(inhibitor.getActiveCount()).toBe(0);
    expect(inhibitor.isRunning()).toBe(false);
  });

  it('ignores a late error event from an already-replaced child', async () => {
    const { children, inhibitor, logger, spawn } = createHarness('linux');

    const first = inhibitor.acquire();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    // First child exits, so this.child is cleared and a re-acquire respawns.
    children[0]!.emit('exit', 0, null);
    const second = inhibitor.acquire();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(3));
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

  it('sanitizes the systemd-inhibit reason (strips control chars, caps length)', async () => {
    const { inhibitor, spawn } = createHarness('linux');

    const handle = inhibitor.acquire(`run\x00 tool\n${'x'.repeat(200)}`);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    const args = spawn.mock.calls[1]![1] as string[];
    const why = args.find((arg) => arg.startsWith('--why='))!;

    // eslint-disable-next-line no-control-regex
    expect(why).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(why.length).toBeLessThanOrEqual('--why='.length + 120);

    handle.release();
  });

  it.each([
    {
      support: true,
      expected: true,
      label: 'includes --no-ask-password when supported',
    },
    {
      support: false,
      expected: false,
      label: 'omits --no-ask-password when not supported',
    },
    {
      support: null,
      expected: false,
      label: 'omits --no-ask-password when unavailable',
    },
  ])('$label', async ({ support, expected }) => {
    const { inhibitor, spawn } = createHarness('linux', {}, support);

    const handle = inhibitor.acquire('working');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    const args = spawn.mock.calls[1]![1] as string[];

    if (expected) {
      expect(args[0]).toBe('--no-ask-password');
    } else {
      expect(args).not.toContain('--no-ask-password');
    }
    expect(args).toContain('--what=sleep');

    handle.release();
  });
});

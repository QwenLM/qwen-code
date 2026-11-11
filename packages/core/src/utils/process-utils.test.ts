/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from 'vitest';
import os from 'node:os';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  killProcessGroup,
  SIGKILL_TIMEOUT_MS,
  WindowsTaskkillError,
} from './process-utils.js';
import { spawnAsync } from './shell-utils.js';
import { runLogger } from './runLogger.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const platform = vi.fn(actual.platform);
  return {
    ...actual,
    default: {
      ...actual,
      platform,
    },
    platform,
  };
});
vi.mock('./shell-utils.js');
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

describe('process-utils', () => {
  let mockProcessKill: MockInstance;
  let mockSpawnAsync: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProcessKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockSpawnAsync = vi.mocked(spawnAsync);
    mockSpawnAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('killProcessGroup', () => {
    it('does not inspect or signal an exited leader whose PID may be reused', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      mockProcessKill.mockImplementation((pid, signal) => {
        if (pid === -1234 && signal === 0)
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true; // Positive PID now belongs to an unrelated process.
      });
      const kill = killProcessGroup({
        pid: 1234,
        escalate: true,
        isLeaderExited: () => true,
      });
      await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS);
      await kill;
      expect(mockSpawnAsync).not.toHaveBeenCalled();
      expect(mockProcessKill.mock.calls).toEqual([
        [-1234, 'SIGTERM'],
        [-1234, 0],
      ]);
    });

    it('discards a descendant snapshot if the original leader exits during enumeration', async () => {
      let exited = false;
      mockSpawnAsync.mockImplementation(async () => {
        exited = true;
        return { stdout: '1234 1\n9999 1234', stderr: '' };
      });
      await killProcessGroup({ pid: 1234, isLeaderExited: () => exited });
      expect(mockProcessKill.mock.calls).toEqual([[-1234, 'SIGKILL']]);
    });

    it('keeps known escaped descendants for escalation after the leader exits', async () => {
      let exited = false;
      let forced = false;
      mockSpawnAsync.mockResolvedValue({
        stdout: '1234 1\n1235 1234',
        stderr: '',
      });
      mockProcessKill.mockImplementation((pid, signal) => {
        if (pid === -1234 && signal === 'SIGTERM') exited = true;
        if (pid === 1235 && signal === 'SIGKILL') forced = true;
        if (signal === 0 && (pid === -1234 || (pid === 1235 && forced)))
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
      const kill = killProcessGroup({
        pid: 1234,
        escalate: true,
        isLeaderExited: () => exited,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS);
      await kill;
      expect(mockSpawnAsync).toHaveBeenCalledOnce();
      expect(
        mockProcessKill.mock.calls.filter(([, signal]) => signal !== 0),
      ).toEqual([
        [1234, 'SIGTERM'],
        [-1234, 'SIGTERM'],
        [1235, 'SIGTERM'],
        [-1234, 'SIGKILL'],
        [1235, 'SIGKILL'],
      ]);
      expect(mockProcessKill).not.toHaveBeenCalledWith(1234, 0);
    });

    it('does not taskkill a Windows leader already known to have exited', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');
      await expect(
        killProcessGroup({ pid: 1234, isLeaderExited: () => true }),
      ).rejects.toThrow('leader');
      expect(mockSpawnAsync).not.toHaveBeenCalled();
    });

    it('should use taskkill on Windows', async () => {
      vi.mocked(os.platform).mockReturnValue('win32');

      await killProcessGroup({ pid: 1234 });

      expect(mockSpawnAsync).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '1234', '/f', '/t'],
        { windowsHide: true, timeout: 2000 },
      );
      expect(mockProcessKill).not.toHaveBeenCalled();
    });

    it.each(['Access is denied', 'taskkill ENOENT', 'process not found'])(
      'propagates Windows termination failure: %s',
      async (message) => {
        vi.mocked(os.platform).mockReturnValue('win32');
        mockSpawnAsync.mockRejectedValueOnce(new Error(message));
        await expect(killProcessGroup({ pid: 1234 })).rejects.toThrow(message);
      },
    );

    describe('bounded Windows taskkill', () => {
      let child: ReturnType<typeof createTaskkillChild>;
      let mockSpawn: MockInstance;
      let deadline: number;

      beforeEach(() => {
        vi.mocked(os.platform).mockReturnValue('win32');
        child = createTaskkillChild();
        mockSpawn = vi.spyOn(childProcess, 'spawn').mockReturnValue(
          child as unknown as ReturnType<typeof childProcess.spawn>,
        );
        deadline = performance.now() + 4500;
      });

      it.each(['exit', 'close'])('accepts an on-time successful %s', async (event) => {
        const kill = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        });
        await vi.advanceTimersByTimeAsync(100);
        child.exitCode = 0;
        child.emit(event, 0, null);
        await expect(kill).resolves.toBeUndefined();
        expect(mockSpawn).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', '1234', '/f', '/t'],
          { windowsHide: true, env: expect.any(Object) },
        );
        expect(mockSpawnAsync).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
        expectTaskkillReleased(child);
      });

      it.each(['exit', 'close'])('makes a confirmed nonzero %s retryable', async (event) => {
        const kill = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        });
        const failure = kill.catch((error: unknown) => error);
        child.stderr.write('Access is denied');
        child.exitCode = 1;
        child.emit(event, 1, null);
        const error = await failure;
        expect(error).toBeInstanceOf(WindowsTaskkillError);
        expect(error).toMatchObject({
          reason: 'taskkill_exit_1',
          retryable: true,
          cause: expect.objectContaining({ message: 'Access is denied' }),
        });
        expect(child.kill).not.toHaveBeenCalled();
        expectTaskkillReleased(child);
      });

      it('does not make an unknown close status retryable', async () => {
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        child.emit('close', null, null);
        expect(await failure).toMatchObject({
          reason: 'taskkill_exit_unknown',
          retryable: false,
        });
        expect(child.kill).not.toHaveBeenCalled();
        expectTaskkillReleased(child);
      });

      it('rejects an exited leader without starting taskkill', async () => {
        const error = await killProcessGroup({
          pid: 1234,
          isLeaderExited: () => true,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(WindowsTaskkillError);
        expect(error).toMatchObject({ reason: 'leader_exited', retryable: false });
        expect(mockSpawn).not.toHaveBeenCalled();
        expect(mockSpawnAsync).not.toHaveBeenCalled();
      });

      it('does not spawn after the overall deadline', async () => {
        const now = performance.now();
        await expect(
          killProcessGroup({ pid: 1234, windowsTaskkill: { deadline: now } }),
        ).rejects.toMatchObject({
          reason: 'deadline_exceeded',
          retryable: false,
          cleanupDeadline: now,
        });
        expect(mockSpawn).not.toHaveBeenCalled();
      });

      it.each([4500, 2300])('bounds a no-close timeout and cleanup by %ims', async (totalMs) => {
        const start = performance.now();
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline: start + totalMs },
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(1999);
        expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const error = await failure;
        expect(error).toBeInstanceOf(WindowsTaskkillError);
        expect(error).toMatchObject({
          reason: 'taskkill_timeout',
          retryable: false,
          cleanupDeadline: start + Math.min(totalMs, 2500),
        });
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expect(mockProcessKill).not.toHaveBeenCalled();
        expect(child.unref).not.toHaveBeenCalled();
        expect(child.listenerCount('exit')).toBe(1);
        expect(child.listenerCount('close')).toBe(1);
        const cleanupMs = Math.min(totalMs, 2500) - 2000;
        child.stderr.write('late diagnostic output');
        await vi.advanceTimersByTimeAsync(cleanupMs - 1);
        expect(child.stderr.destroyed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expectTaskkillReleased(child);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(() => child.emit('error', new Error('after release'))).not.toThrow();
      });

      it('uses the remaining overall deadline rather than another 2000ms', async () => {
        const start = performance.now();
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline: start + 600 },
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(600);
        expect(await failure).toMatchObject({
          reason: 'deadline_exceeded',
          retryable: false,
          cleanupDeadline: start + 600,
        });
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expectTaskkillReleased(child);
      });

      it('never upgrades a timeout when success arrives during cleanup', async () => {
        const resolved = vi.fn();
        const rejected = vi.fn((error: unknown) => error);
        const result = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).then(resolved, rejected);
        await vi.advanceTimersByTimeAsync(2000);
        const error = await result;
        await vi.advanceTimersByTimeAsync(100);
        child.exitCode = 0;
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
        expect(await result).toBe(error);
        expect(error).toMatchObject({ reason: 'taskkill_timeout', retryable: false });
        expect(resolved).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledTimes(1);
        expectTaskkillReleased(child);
      });

      it.each(['exit', 'close'])('checks monotonic time before a late successful %s when the timer is delayed', async (event) => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(100);
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline: 4600 },
        }).catch((error: unknown) => error);
        vi.setSystemTime(new Date('2000-01-01'));
        now.mockReturnValue(2100);
        child.exitCode = 0;
        child.emit(event, 0, null);
        expect(await failure).toMatchObject({
          reason: 'taskkill_timeout',
          retryable: false,
          cleanupDeadline: 2600,
        });
        expect(child.kill).not.toHaveBeenCalled();
        expectTaskkillReleased(child);
      });

      it('checks the overall deadline in a delayed error handler', async () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(100);
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline: 600 },
        }).catch((error: unknown) => error);
        now.mockReturnValue(601);
        child.emit('error', new Error('taskkill ENOENT'));
        expect(await failure).toMatchObject({
          reason: 'deadline_exceeded',
          retryable: false,
          cleanupDeadline: 600,
        });
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
        expectTaskkillReleased(child);
      });

      it.each(['exitCode', 'signalCode'] as const)('does not kill a child whose %s already confirms exit', async (field) => {
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        if (field === 'exitCode') child.exitCode = 1;
        else child.signalCode = 'SIGKILL';
        await vi.advanceTimersByTimeAsync(2000);
        expect(await failure).toMatchObject({ reason: 'taskkill_timeout', retryable: false });
        expect(child.kill).not.toHaveBeenCalled();
        expectTaskkillReleased(child);
      });

      it.each(['false', 'throw'])('bounds cleanup when child.kill returns %s', async (mode) => {
        const warning = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
        child.kill.mockImplementation(() => {
          if (mode === 'throw') throw Object.assign(new Error('denied'), { code: 'EPERM' });
          return false;
        });
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(2000);
        expect(await failure).toMatchObject({ reason: 'taskkill_timeout', retryable: false });
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('termination request'));
        child.emit('error', new Error('kill failed'));
        await vi.advanceTimersByTimeAsync(500);
        expectTaskkillReleased(child);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      it('makes a synchronous spawn failure non-retryable', async () => {
        mockSpawn.mockImplementation(() => {
          throw new Error('taskkill ENOENT');
        });
        const error = await killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(WindowsTaskkillError);
        expect(error).toMatchObject({
          reason: 'taskkill_spawn_error: Error: taskkill ENOENT',
          retryable: false,
        });
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect(mockSpawnAsync).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      });

      it.each([false, true])('only makes an error retryable with confirmed exit=%s', async (exited) => {
        const failure = killProcessGroup({
          pid: 1234,
          windowsTaskkill: { deadline },
        }).catch((error: unknown) => error);
        const cause = new Error('taskkill ENOENT');
        if (exited) child.exitCode = 1;
        child.emit('error', cause);
        expect(await failure).toMatchObject({
          reason: 'taskkill_error: taskkill ENOENT',
          retryable: exited,
          cause,
        });
        expectTaskkillReleased(child);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['SYSTEMROOT', 'PATH'],
        ['SystemRoot', 'Path'],
      ])(
        'sanitizes %s / %s environment keys without logging secrets',
        async (systemRootKey, pathKey) => {
          vi.stubEnv('SURFACE', 'Github');
          vi.stubEnv('PROCESS_UTILS_TEST_TOKEN', 'do-not-pass-this-secret');
          for (const key of Object.keys(process.env)) {
            if (['SYSTEMROOT', 'PATH'].includes(key.toUpperCase())) {
              vi.stubEnv(key, undefined);
            }
          }
          vi.stubEnv(systemRootKey, 'C:\\Windows');
          vi.stubEnv(pathKey, 'C:\\Windows\\System32');
          const debug = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
          const warning = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
          const failure = killProcessGroup({
            pid: 1234,
            windowsTaskkill: { deadline },
          }).catch((error: unknown) => error);
          const env = mockSpawn.mock.calls[0][2].env as NodeJS.ProcessEnv;
          const normalizedEnv = Object.fromEntries(
            Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]),
          );
          expect(normalizedEnv['PROCESS_UTILS_TEST_TOKEN']).toBeUndefined();
          expect(normalizedEnv['SYSTEMROOT']).toBe('C:\\Windows');
          expect(normalizedEnv['PATH']).toBe('C:\\Windows\\System32');
          expect(env).not.toBe(process.env);
          child.stderr.write('private complete taskkill output');
          child.exitCode = 1;
          child.emit('exit', 1, null);
          const error = await failure;
          expect(String(error)).not.toContain('private complete taskkill output');
          const logs = [...debug.mock.calls, ...warning.mock.calls]
            .flat()
            .join('\n');
          expect(logs).not.toContain('private complete taskkill output');
          expect(logs).not.toContain('do-not-pass-this-secret');
          expect(logs).not.toContain('/pid');
          expectTaskkillReleased(child);
        },
      );
    });

    it('should kill the process group on Unix with SIGKILL by default', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');

      await killProcessGroup({ pid: 1234 });

      expect(mockSpawnAsync).toHaveBeenCalledWith(
        'ps',
        ['-A', '-o', 'pid=', '-o', 'ppid='],
        { cwd: '/', timeout: 500 },
      );
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    });

    it('should signal every recursively enumerated descendant on Unix', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      mockSpawnAsync.mockResolvedValue({
        stdout: ['1234 1', '1235 1234', '1236 1235', '2000 1'].join('\n'),
        stderr: '',
      });

      await killProcessGroup({ pid: 1234 });

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
      expect(mockProcessKill).toHaveBeenCalledWith(1235, 'SIGKILL');
      expect(mockProcessKill).toHaveBeenCalledWith(1236, 'SIGKILL');
      expect(mockProcessKill).not.toHaveBeenCalledWith(2000, 'SIGKILL');
    });

    it('should use escalation on Unix if requested', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');

      const killPromise = killProcessGroup({
        pid: 1234,
        escalate: true,
      });

      await vi.advanceTimersByTimeAsync(0);

      // The leader must receive SIGTERM before the group can wake its children.
      expect(mockProcessKill.mock.calls[0]).toEqual([1234, 'SIGTERM']);
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGTERM');

      // Advance time
      await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS);

      // Second call should be SIGKILL
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
      const forceSignals = mockProcessKill.mock.calls.filter(
        ([, signal]) => signal === 'SIGKILL',
      );
      expect(forceSignals.slice(0, 2)).toEqual([
        [1234, 'SIGKILL'],
        [-1234, 'SIGKILL'],
      ]);
      expect(mockSpawnAsync).toHaveBeenCalledTimes(2);

      await killPromise;
    });

    it('should not escalate after both the process group and leader exit', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      mockProcessKill.mockImplementation((_pid, signal) => {
        if (signal === 0) {
          throw Object.assign(new Error('process not found'), {
            code: 'ESRCH',
          });
        }
        return true;
      });

      await killProcessGroup({
        pid: 1234,
        escalate: true,
      });

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGTERM');
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 0);
      expect(mockProcessKill).toHaveBeenCalledWith(1234, 0);
      expect(mockProcessKill).not.toHaveBeenCalledWith(-1234, 'SIGKILL');
      expect(mockSpawnAsync).toHaveBeenCalledTimes(1);
    });

    it('still signals the leader when its process group is unavailable', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      mockProcessKill.mockImplementation((pid) => {
        if (pid < 0) throw new Error('ESRCH');
        return true;
      });

      await killProcessGroup({ pid: 1234 });

      // Failed group kill
      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
      // The individual leader was already signalled before trying the group.
      expect(mockProcessKill).toHaveBeenCalledWith(1234, 'SIGKILL');
      expect(mockProcessKill.mock.calls[0]).toEqual([1234, 'SIGKILL']);
    });

    it('signals the leader before a group broadcast or any known descendant', async () => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      mockSpawnAsync.mockResolvedValue({
        stdout: '1234 1\n1235 1234\n1236 1235',
        stderr: '',
      });
      mockProcessKill.mockImplementation((_pid, signal) => {
        if (signal === 0)
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
      await killProcessGroup({ pid: 1234, escalate: true });
      expect(
        mockProcessKill.mock.calls.filter(([, signal]) => signal !== 0),
      ).toEqual([
        [1234, 'SIGTERM'],
        [-1234, 'SIGTERM'],
        [1235, 'SIGTERM'],
        [1236, 'SIGTERM'],
      ]);
    });

    it('should still signal the process group when descendant enumeration fails', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');
      mockSpawnAsync.mockRejectedValueOnce(new Error('ps failed'));

      await killProcessGroup({ pid: 1234 });

      expect(mockProcessKill).toHaveBeenCalledWith(-1234, 'SIGKILL');
    });

    it('should reject unsafe process IDs before enumerating descendants', async () => {
      vi.mocked(os.platform).mockReturnValue('linux');

      await killProcessGroup({ pid: 1 });

      expect(mockSpawnAsync).not.toHaveBeenCalled();
      expect(mockProcessKill).not.toHaveBeenCalled();
    });
  });
});

function createTaskkillChild() {
  return Object.assign(new EventEmitter(), {
    pid: 9876,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

function expectTaskkillReleased(child: ReturnType<typeof createTaskkillChild>) {
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('close')).toBe(0);
  expect(child.listenerCount('error')).toBe(1);
  expect(child.stderr.listenerCount('data')).toBe(0);
  expect(child.stdin.destroyed).toBe(true);
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
}

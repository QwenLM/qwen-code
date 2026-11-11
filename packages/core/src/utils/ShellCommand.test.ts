/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  wrapSpawn,
  createAbortedCommand,
  createFailedCommand,
  ShellTerminationError,
} from './ShellCommand.js';
import type { TaskOutput } from './task/TaskOutput.js';
import { MAX_TASK_OUTPUT_BYTES } from './task/diskOutput.js';
import * as processUtils from './process-utils.js';
import { SIGKILL_TIMEOUT_MS } from './process-utils.js';

const isWindows = os.platform() === 'win32';

describe('ShellCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('captures root-exit timing despite wall-clock rollback', async () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(10000);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    try {
      const command = wrapSpawn(child, new AbortController().signal, 0);
      clock.mockReturnValue(200);
      command.background('background-task');
      wall.mockReturnValue(5000);
      clock.mockReturnValue(260);
      child.emit('exit', 0, null);
      wall.mockReturnValue(999999);
      clock.mockReturnValue(90000);
      expect((await command.result).processTiming).toEqual({
        startedAt: 10000,
        endedAt: 5000,
        durationMs: 160,
      });
      command.cleanup();
    } finally {
      wall.mockRestore();
      clock.mockRestore();
    }
  });

  describe('wrapSpawn', { skip: isWindows, timeout: 10_000 }, () => {
    it('should capture stdout and exit code 0 for a successful command', async () => {
      const ac = new AbortController();
      const child = spawn('echo', ['hello'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.stdout.trim()).toBe('hello');
      expect(result.code).toBe(0);
      expect(result.interrupted).toBe(false);
      expect(cmd.status).toBe('completed');

      cmd.cleanup();
    });

    it('should capture stderr and non-zero exit code', async () => {
      const ac = new AbortController();
      const child = spawn('bash', ['-c', 'echo err >&2; exit 42'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.stderr.trim()).toBe('err');
      expect(result.code).toBe(42);
      expect(result.interrupted).toBe(false);

      cmd.cleanup();
    });

    it('should keep an explicit high exit code separate from signals', async () => {
      const ac = new AbortController();
      const child = spawn('bash', ['-c', 'exit 137'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.code).toBe(137);
      expect(result.signal).toBeUndefined();

      cmd.cleanup();
    });

    it('should capture the actual terminating signal', async () => {
      const ac = new AbortController();
      const child = spawn('bash', ['-c', 'kill -TERM $$'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.code).toBe(143);
      expect(result.signal).toBe(os.constants.signals.SIGTERM);

      cmd.cleanup();
    });

    it('should use the final pipeline command status by default', async () => {
      const ac = new AbortController();
      const child = spawn(
        'bash',
        ['-c', 'bash ./definitely-missing-qwen-script.sh 2>&1 | head -30'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No such file or directory');

      cmd.cleanup();
    });

    it('should preserve a pipeline failure when pipefail is enabled', async () => {
      const ac = new AbortController();
      const child = spawn(
        'bash',
        [
          '-c',
          'set -o pipefail; bash ./definitely-missing-qwen-script.sh 2>&1 | head -30',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const cmd = wrapSpawn(child, ac.signal, 0);

      const result = await cmd.result;

      expect(result.code).toBe(127);
      expect(result.stdout).toContain('No such file or directory');

      cmd.cleanup();
    });
  });

  describe('createAbortedCommand', () => {
    it('should return interrupted=true and code=145 by default', async () => {
      const cmd = createAbortedCommand();
      const result = await cmd.result;

      expect(result.interrupted).toBe(true);
      expect(result.code).toBe(145);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(cmd.status).toBe('completed');
    });

    it('should accept custom stderr and code via opts', async () => {
      const cmd = createAbortedCommand('task-1', {
        stderr: 'aborted!',
        code: 130,
      });
      const result = await cmd.result;

      expect(result.code).toBe(130);
      expect(result.stderr).toBe('aborted!');
      expect(result.backgroundTaskId).toBe('task-1');
    });

    it('should return false from background()', () => {
      const cmd = createAbortedCommand();
      expect(cmd.background('x')).toBe(false);
    });
  });

  describe('createFailedCommand', () => {
    it('should return preSpawnError and code=1', async () => {
      const cmd = createFailedCommand('command not found');
      const result = await cmd.result;

      expect(result.code).toBe(1);
      expect(result.preSpawnError).toBe('command not found');
      expect(result.interrupted).toBe(false);
      expect(result.stdout).toBe('');
      expect(cmd.status).toBe('completed');
    });

    it('should return false from background()', () => {
      const cmd = createFailedCommand('err');
      expect(cmd.background('x')).toBe(false);
    });
  });

  describe('state transitions', { skip: isWindows, timeout: 10_000 }, () => {
    it('should transition from running to completed on normal exit', async () => {
      const ac = new AbortController();
      const child = spawn('echo', ['done'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      expect(cmd.status).toBe('running');

      await cmd.result;

      expect(cmd.status).toBe('completed');

      cmd.cleanup();
    });

    it('should transition from running to killed when kill() is called', async () => {
      const ac = new AbortController();
      const child = spawn('sleep', ['30'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      expect(cmd.status).toBe('running');

      const killPromise = cmd.kill();

      expect(cmd.status).toBe('killed');
      expect(cmd.kill()).toBe(killPromise);

      await killPromise;

      const result = await cmd.result;
      expect(result.interrupted).toBe(true);

      cmd.cleanup();
    });

    it('kill() should be a no-op if already completed', async () => {
      const ac = new AbortController();
      const child = spawn('true', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      await cmd.result;

      expect(cmd.status).toBe('completed');

      // Should not throw or change status
      await cmd.kill();
      expect(cmd.status).toBe('completed');

      cmd.cleanup();
    });
  });

  describe('background', { skip: isWindows, timeout: 10_000 }, () => {
    it('should transition from running to backgrounded then completed', async () => {
      const ac = new AbortController();
      const child = spawn('bash', ['-c', 'echo bg; exit 0'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      expect(cmd.status).toBe('running');

      const ok = cmd.background('bg-task-1');
      expect(ok).toBe(true);
      expect(cmd.status).toBe('backgrounded');

      const result = await cmd.result;

      expect(cmd.status).toBe('completed');
      expect(result.backgroundTaskId).toBe('bg-task-1');
      expect(result.code).toBe(0);

      cmd.cleanup();
    });

    it('should return false if not in running state', async () => {
      const ac = new AbortController();
      const child = spawn('true', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      await cmd.result;

      // Already completed
      expect(cmd.background('x')).toBe(false);

      cmd.cleanup();
    });
  });

  describe('termination completion barrier', () => {
    it.each([
      { exitCode: 0, signalCode: null },
      { exitCode: null, signalCode: 'SIGTERM' },
    ])(
      'reports native child exit state before the exit listener runs: %j',
      async (state) => {
        const killSpy = vi
          .spyOn(processUtils, 'killProcessGroup')
          .mockResolvedValue();
        const child = Object.assign(new EventEmitter(), {
          pid: 12345,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          exitCode: null,
          signalCode: null,
        }) as unknown as ChildProcess;
        const cmd = wrapSpawn(child, new AbortController().signal, 0);
        await cmd.kill();
        const exited = killSpy.mock.calls[0][0].isLeaderExited;
        expect(exited?.()).toBe(false);
        Object.assign(child, state);
        expect(exited?.()).toBe(true);
        child.emit('exit', state.exitCode, state.signalCode);
        await cmd.result;
        cmd.cleanup();
      },
    );

    it.each(['abort', 'kill', 'timeout'] as const)(
      'waits for process-tree termination after root exit on %s',
      async (reason) => {
        vi.useFakeTimers();
        let finishKill!: () => void;
        const killSpy = vi
          .spyOn(processUtils, 'killProcessGroup')
          .mockReturnValue(
            new Promise<void>((resolve) => {
              finishKill = resolve;
            }),
          );
        const child = Object.assign(new EventEmitter(), {
          pid: 12345,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        const controller = new AbortController();
        const cmd = wrapSpawn(
          child,
          controller.signal,
          reason === 'timeout' ? 10 : 0,
        );
        let settled = false;
        void cmd.result.then(() => {
          settled = true;
        });
        try {
          if (reason === 'abort') controller.abort();
          else if (reason === 'kill') void cmd.kill();
          else await vi.advanceTimersByTimeAsync(10);
          const isLeaderExited = killSpy.mock.calls[0][0].isLeaderExited;
          expect(isLeaderExited?.()).toBe(false);
          child.emit('exit', null, 'SIGTERM');
          expect(isLeaderExited?.()).toBe(true);
          await Promise.resolve();
          expect(settled).toBe(false);
          finishKill();
          expect(await cmd.result).toMatchObject({
            code: 143,
            timedOut: reason === 'timeout',
          });
          expect(settled).toBe(true);
        } finally {
          finishKill();
          cmd.cleanup();
          vi.useRealTimers();
        }
      },
    );

    it.each([true, false])(
      'does not publish a successful terminal result when termination fails (root exits first: %s)',
      async (rootExitsFirst) => {
        let failKill!: (error: Error) => void;
        vi.spyOn(processUtils, 'killProcessGroup').mockReturnValue(
          new Promise<void>((_resolve, reject) => {
            failKill = reject;
          }),
        );
        const child = Object.assign(new EventEmitter(), {
          pid: 12345,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        const cmd = wrapSpawn(child, new AbortController().signal, 0);
        const result = cmd.result.catch((error: unknown) => error);
        const kill = cmd.kill().catch((error: unknown) => error);
        if (rootExitsFirst) child.emit('exit', null, 'SIGTERM');
        failKill(new Error('termination denied'));
        await kill;
        if (!rootExitsFirst) child.emit('exit', null, 'SIGTERM');
        const resultError = (await result) as ShellTerminationError;
        expect(resultError).toBeInstanceOf(ShellTerminationError);
        expect(resultError.message).toBe('termination denied');
        expect(resultError.result).toMatchObject({
          code: 143,
          timedOut: false,
          outputLimitExceeded: false,
          interrupted: true,
        });
        expect(await kill).toEqual(new Error('termination denied'));
        await expect(cmd.kill()).rejects.toThrow('termination denied');
        expect(processUtils.killProcessGroup).toHaveBeenCalledOnce();
        cmd.cleanup();
      },
    );

    it('preserves the background task id in a termination error', async () => {
      let failKill!: (error: Error) => void;
      vi.spyOn(processUtils, 'killProcessGroup').mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          failKill = reject;
        }),
      );
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      const cmd = wrapSpawn(child, new AbortController().signal, 0);
      cmd.background('btask');
      const result = cmd.result.catch((error: unknown) => error);
      const kill = cmd.kill().catch((error: unknown) => error);
      try {
        child.emit('exit', null, 'SIGTERM');
        failKill(new Error('termination denied'));
        const error = (await result) as ShellTerminationError;
        expect(error).toBeInstanceOf(ShellTerminationError);
        expect(error.result.backgroundTaskId).toBe('btask');
        await kill;
      } finally {
        failKill?.(new Error('cleanup'));
        cmd.cleanup();
      }
    });

    it('carries timeout semantics when termination fails after root exit', async () => {
      vi.useFakeTimers();
      let failKill!: (error: Error) => void;
      vi.spyOn(processUtils, 'killProcessGroup').mockReturnValue(
        new Promise<void>((_resolve, reject) => {
          failKill = reject;
        }),
      );
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      const cmd = wrapSpawn(child, new AbortController().signal, 10);
      const result = cmd.result.catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(10);
        child.emit('exit', null, 'SIGTERM');
        failKill(new Error('termination denied'));
        const error = (await result) as ShellTerminationError;
        expect(error).toBeInstanceOf(ShellTerminationError);
        expect(error.result).toMatchObject({
          code: 143,
          timedOut: true,
          outputLimitExceeded: false,
          interrupted: true,
        });
      } finally {
        failKill?.(new Error('cleanup'));
        cmd.cleanup();
        vi.useRealTimers();
      }
    });
  });

  describe('output file cap', { skip: isWindows }, () => {
    it('watches foreground file output and terminates the process group', async () => {
      vi.useFakeTimers();
      const outputDir = mkdtempSync(
        path.join(os.tmpdir(), 'test-output-cap-'),
      );
      const outputPath = path.join(outputDir, 'task.output');
      writeFileSync(outputPath, '');
      truncateSync(outputPath, MAX_TASK_OUTPUT_BYTES + 1);

      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      }) as unknown as ChildProcess;
      const taskOutput = {
        stdoutToFile: true,
        path: outputPath,
        clear: vi.fn(),
      } as unknown as TaskOutput;
      const killSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) => {
          if (pid === -12345 && signal === 'SIGTERM') {
            queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
          }
          return true;
        });

      const cmd = wrapSpawn(
        child,
        new AbortController().signal,
        0,
        false,
        taskOutput,
      );

      try {
        expect(cmd.status).toBe('running');
        await vi.advanceTimersByTimeAsync(5000);
        await vi.waitFor(() =>
          expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM'),
        );
        await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS);
        const result = await cmd.result;
        await cmd.kill();

        expect(result.outputLimitExceeded).toBe(true);
        expect(result.interrupted).toBe(true);
        expect(result.stderr).toContain('output file exceeded 5GB');
        expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGKILL');
      } finally {
        cmd.cleanup();
        rmSync(outputDir, { recursive: true, force: true });
        vi.useRealTimers();
      }
    });
  });

  describe('timeout handling', { skip: isWindows, timeout: 10_000 }, () => {
    it('should kill the process when timeout expires', async () => {
      const ac = new AbortController();
      const child = spawn('sleep', ['30'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 100);

      const result = await cmd.result;

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('timed out');
      expect(result.interrupted).toBe(false);

      cmd.cleanup();
    });

    it('should invoke onTimeout callback when shouldAutoBackground is true', async () => {
      const ac = new AbortController();
      const child = spawn('sleep', ['30'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 100, true);

      const timeoutPromise = new Promise<void>((resolve) => {
        cmd.onTimeout!((backgroundFn) => {
          const ok = backgroundFn('auto-bg-1');
          expect(ok).toBe(true);
          expect(cmd.status).toBe('backgrounded');
          resolve();
        });
      });

      await timeoutPromise;

      // Kill it so the test finishes
      await cmd.kill();
      await cmd.result;

      cmd.cleanup();
    });
  });

  describe('abort signal', { skip: isWindows, timeout: 10_000 }, () => {
    it('should kill the process when abort signal fires', async () => {
      const ac = new AbortController();
      const child = spawn('sleep', ['30'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      expect(cmd.status).toBe('running');

      ac.abort();

      const result = await cmd.result;

      expect(result.code).not.toBe(0);

      cmd.cleanup();
    });

    it('should not kill when abort reason is "interrupt"', async () => {
      const ac = new AbortController();
      const child = spawn('bash', ['-c', 'echo ok; exit 0'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const cmd = wrapSpawn(child, ac.signal, 0);

      ac.abort('interrupt');

      const result = await cmd.result;

      // Process should complete normally since interrupt aborts are ignored
      expect(result.stdout.trim()).toBe('ok');
      expect(result.code).toBe(0);

      cmd.cleanup();
    });
  });
});

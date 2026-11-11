/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { execFileNoThrow } from './execFileNoThrow.js';
import { runLogger } from './runLogger.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    spawn: vi.fn(actual.spawn),
  };
});

describe('execFileNoThrow', () => {
  it('passes an explicit environment to the child process', async () => {
    const result = await execFileNoThrow(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CLI_EXEC_TEST ?? "")'],
      {
        env: { ...process.env, CLI_EXEC_TEST: 'isolated' },
      },
    );

    expect(result).toEqual({
      stdout: 'isolated',
      stderr: '',
      code: 0,
    });
  });

  it('settles at its own deadline even when a descendant keeps pipes open', async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"],',
      '  { stdio: ["ignore", "inherit", "inherit"] });',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const startedAt = Date.now();

    const result = await execFileNoThrow(process.execPath, ['-e', script], {
      timeout: 40,
    });

    expect(result).toMatchObject({ code: 1, timedOut: true });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('settles promptly when its signal is aborted', async () => {
    const controller = new AbortController();
    const running = execFileNoThrow(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { signal: controller.signal },
    );

    controller.abort();

    await expect(running).resolves.toEqual({
      stdout: '',
      stderr: '',
      code: 1,
    });
  });
});

function createTestChild(pid: number) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
}

describe('execFileNoThrow Windows process-tree cleanup', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let parent: ReturnType<typeof createTestChild>;
  let taskkills: Array<ReturnType<typeof createTestChild>>;

  beforeAll(async () => {
    await import('./process-utils.js');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(runLogger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(runLogger, 'warn').mockImplementation(() => undefined);
    parent = createTestChild(1234);
    taskkills = [createTestChild(2345), createTestChild(2346)];
    vi.mocked(childProcess.execFile).mockReturnValue(
      parent as unknown as childProcess.ChildProcess,
    );
    vi.mocked(childProcess.spawn).mockImplementation(
      () => taskkills[vi.mocked(childProcess.spawn).mock.calls.length - 1] as unknown as childProcess.ChildProcess,
    );
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function start(timeout = 1000) {
    const controller = new AbortController();
    const result = execFileNoThrow('git', ['status', '--short'], {
      timeout,
      signal: controller.signal,
      windowsProcessTreeCleanup: { source: 'system-context' },
    });
    return { controller, result };
  }

  function completeQuery(error: childProcess.ExecFileException | null = null) {
    const callback = vi.mocked(childProcess.execFile).mock.calls[0][3] as unknown as (
      error: childProcess.ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void;
    callback(error, 'query output', '');
  }

  function exitTaskkill(index: number, code: number) {
    taskkills[index].exitCode = code;
    taskkills[index].emit('exit', code, null);
    taskkills[index].emit('close', code, null);
  }

  it('preserves normal results without starting cleanup or forwarding the abort signal', async () => {
    const { result } = start();
    expect(vi.mocked(childProcess.execFile).mock.calls[0][2]).not.toHaveProperty('signal');
    completeQuery();
    await expect(result).resolves.toEqual({
      code: 0,
      stdout: 'query output',
      stderr: '',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(parent.kill).not.toHaveBeenCalled();
    expect(parent.unref).not.toHaveBeenCalled();
  });

  it('preserves ordinary failures without invoking tree cleanup', async () => {
    const { result } = start();
    completeQuery(Object.assign(new Error('query failed'), { code: 2 }));
    await expect(result).resolves.toMatchObject({ code: 2 });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(parent.kill).not.toHaveBeenCalled();
  });

  it('returns its original timeout result while tree cleanup finishes independently', async () => {
    const { result } = start(20);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toEqual({ code: 1, stdout: '', stderr: '', timedOut: true });
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(parent.kill).not.toHaveBeenCalled();
    completeQuery();
    exitTaskkill(0, 0);
    parent.exitCode = 1;
    parent.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.unref).toHaveBeenCalledOnce();
    expect(parent.stdout.destroyed).toBe(true);
    expect(parent.kill).not.toHaveBeenCalled();
    expect(runLogger.debug).toHaveBeenCalledWith(expect.stringContaining('termination_command_succeeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the original deadline and warns if the budget timer wins finalization', async () => {
    vi.mocked(runLogger.debug).mockImplementationOnce(() => {
      vi.advanceTimersByTime(2200);
    });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const { controller } = start(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 2300);
    await vi.advanceTimersByTimeAsync(1950);
    exitTaskkill(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(runLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('termination_command_succeeded'),
    );
    expect(parent.unref).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(parent.unref).toHaveBeenCalledOnce();
    expect(runLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('reason=leader_exit_unconfirmed'),
    );
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one cumulative retry budget after a failure and repeated cancellation', async () => {
    const { controller, result } = start();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    exitTaskkill(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    expect(parent.kill).not.toHaveBeenCalled();
    controller.abort();
    exitTaskkill(1, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(parent.kill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ code: 1, stdout: '', stderr: '' });
    expect(parent.unref).toHaveBeenCalledOnce();
    expect(parent.stderr.destroyed).toBe(true);
    const logCount = vi.mocked(runLogger.debug).mock.calls.length;
    taskkills[0].emit('close', 0, null);
    parent.emit('exit', 0, null);
    parent.emit('error', new Error('late error'));
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(vi.mocked(runLogger.debug).mock.calls).toHaveLength(logCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a taskkill without close, does not retry it, and does not promote late success', async () => {
    const { controller, result } = start();
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    expect(taskkills[0].kill).toHaveBeenCalledOnce();
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(runLogger.warn).toHaveBeenCalledWith(expect.stringContaining('cleanup_unconfirmed'));
    taskkills[0].exitCode = 0;
    taskkills[0].emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ code: 1, stdout: '', stderr: '' });
    expect(parent.unref).toHaveBeenCalledOnce();
    expect(taskkills[0].unref).toHaveBeenCalledOnce();
    expect(runLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('termination_command_succeeded'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports an already-exited leader as unconfirmed without taskkill or PID-based fallback', async () => {
    const { controller } = start();
    parent.exitCode = 0;
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(parent.kill).not.toHaveBeenCalled();
    expect(runLogger.warn).toHaveBeenCalledWith(expect.stringContaining('reason=leader_exited'));
    expect(parent.unref).toHaveBeenCalledOnce();
  });

  it('does not retry after the leader exits during a failed attempt', async () => {
    const { controller } = start();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    exitTaskkill(0, 1);
    parent.exitCode = 0;
    parent.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(parent.kill).not.toHaveBeenCalled();
    expect(parent.unref).toHaveBeenCalledOnce();
  });

  it('checks the monotonic deadline before accepting a result when timers are delayed', async () => {
    const { controller } = start();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, 'now').mockReturnValue(4501);
    exitTaskkill(0, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(childProcess.spawn).toHaveBeenCalledOnce();
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(parent.unref).toHaveBeenCalledOnce();
    expect(runLogger.debug).not.toHaveBeenCalledWith(expect.stringContaining('termination_command_succeeded'));
  });

  it('logs an unsuccessful direct-process fallback without retrying cleanup', async () => {
    const { controller } = start();
    parent.kill.mockReturnValue(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    exitTaskkill(0, 1);
    await vi.advanceTimersByTimeAsync(0);
    exitTaskkill(1, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(runLogger.warn).toHaveBeenCalledWith(expect.stringContaining('requested=false'));
    expect(runLogger.warn).toHaveBeenCalledWith(expect.stringContaining('leader_exit_unconfirmed'));
    expect(parent.unref).toHaveBeenCalledOnce();
  });

  it('keeps the previous Windows behavior for callers without opt-in', async () => {
    const controller = new AbortController();
    const result = execFileNoThrow('git', [], { signal: controller.signal });
    expect(vi.mocked(childProcess.execFile).mock.calls[0][2]).toHaveProperty('signal', controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ code: 1, stdout: '', stderr: '' });
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('keeps the previous non-Windows behavior even when opt-in is provided', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { controller, result } = start();
    expect(vi.mocked(childProcess.execFile).mock.calls[0][2]).toHaveProperty('signal', controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ code: 1, stdout: '', stderr: '' });
    expect(parent.kill).toHaveBeenCalledOnce();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

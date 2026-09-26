/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { runOwnedCommand, type OwnedCommandOptions } from './owned-command.js';

const { mockSpawn, mockSpawnSync, mockExecFile, mockPlatform } = vi.hoisted(
  () => ({
    mockSpawn: vi.fn(),
    mockSpawnSync: vi.fn(),
    mockExecFile: vi.fn(),
    mockPlatform: vi.fn(),
  }),
);

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
  execFile: mockExecFile,
}));
vi.mock('node:os', () => ({ default: { platform: mockPlatform } }));

describe('runOwnedCommand', () => {
  const pid = 45678;
  const member = (id: number, group = pid) =>
    `${id} ${group} Wed Sep 9 10:00:00 2026 S\n`;
  let snapshot: string;
  let snapshotError: Error | undefined;
  let child: EventEmitter & {
    pid: number | undefined;
    stdout: PassThrough;
    stderr: PassThrough;
  };
  let pending: Array<ReturnType<typeof runOwnedCommand>>;
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pending = [];
    snapshot = member(pid) + member(pid + 1);
    snapshotError = undefined;
    mockPlatform.mockReturnValue('linux');
    kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    mockSpawnSync.mockImplementation(() => ({ status: 0, stdout: snapshot }));
    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(snapshotError ?? null, snapshot),
    );
    child = Object.assign(new EventEmitter(), {
      pid: pid as number | undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    mockSpawn.mockReturnValue(child);
  });

  afterEach(async () => {
    snapshot = member(pid + 999, pid + 999);
    snapshotError = undefined;
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(pending);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start(options: OwnedCommandOptions = {}) {
    const result = runOwnedCommand(
      'fixture-command',
      ['-e', 'a;$(b)'],
      options,
    );
    pending.push(result);
    const settled = vi.fn();
    void result.then(settled);
    return { result, settled };
  }

  function groupExit() {
    snapshot = member(pid + 999, pid + 999);
  }

  it('passes argv, cwd and explicit env directly and preserves both output streams', async () => {
    const env = { PATH: '/trusted/bin' };
    const run = start({ cwd: '/workspace/child', env });
    expect(mockSpawn).toHaveBeenCalledWith(
      'fixture-command',
      ['-e', 'a;$(b)'],
      {
        cwd: '/workspace/child',
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.write('matched\n');
    child.stderr.write('diagnostic\n');
    groupExit();
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toEqual({
      stdout: 'matched\n',
      stderr: 'diagnostic\n',
      code: 0,
      signal: null,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('waits for descendants after the wrapper closes its streams and exits', async () => {
    const run = start();
    snapshot = member(pid + 1);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(500);
    expect(run.settled).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect((await run.result).code).toBe(0);
  });

  it('waits for close after the owned group is gone', async () => {
    const run = start();
    groupExit();
    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(500);
    expect(run.settled).not.toHaveBeenCalled();
    child.stdout.write('last pipe output\n');
    child.emit('close', 0, null);
    expect((await run.result).stdout).toBe('last pipe output\n');
  });

  it('cancels surviving descendants and waits beyond KILL until actual exit', async () => {
    const controller = new AbortController();
    const run = start({ signal: controller.signal });
    child.stdout.write('partial\n');
    snapshot = member(pid + 1);
    child.emit('close', 0, null);
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(run.settled).not.toHaveBeenCalled();
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toMatchObject({
      stdout: 'partial\n',
      code: 0,
      signal: null,
      error: { name: 'AbortError', code: 'ABORT_ERR' },
    });
  });

  it('preserves timeout as the cause after TERM is ignored and KILL closes the child', async () => {
    const run = start({ timeout: 100 });
    child.stdout.write('partial');
    await vi.advanceTimersByTimeAsync(500);
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(run.settled).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(run.settled).not.toHaveBeenCalled();
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toMatchObject({
      stdout: 'partial',
      code: null,
      signal: 'SIGKILL',
      error: { code: 'ETIMEDOUT' },
    });
  });

  it.each(['stdout', 'stderr'] as const)(
    'bounds %s in bytes while draining the entire group',
    async (stream) => {
      const controller = new AbortController();
      const run = start({ maxBuffer: 4, signal: controller.signal });
      child[stream].write('1234');
      await vi.advanceTimersByTimeAsync(100);
      expect(kill).not.toHaveBeenCalled();
      child[stream].write('56789');
      controller.abort();
      await vi.advanceTimersByTimeAsync(500);
      expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
      expect(run.settled).not.toHaveBeenCalled();
      child[stream].write('discarded');
      child.emit('close', null, 'SIGKILL');
      groupExit();
      await vi.advanceTimersByTimeAsync(100);
      expect(await run.result).toMatchObject({
        [stream]: '1234',
        error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      });
    },
  );

  it('allows an explicit unlimited buffer', async () => {
    const run = start({ maxBuffer: Infinity });
    const output = Buffer.alloc(1024 * 1024 + 1, 'a');
    child.stdout.write(output);
    child.emit('close', 0, null);
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect((await run.result).stdout.length).toBe(output.length);
    expect((await run.result).error).toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
  });

  it('preserves a numeric nonzero exit and stderr for caller no-match/error policy', async () => {
    const run = start();
    child.stderr.write('diagnostic');
    child.emit('close', 1, null);
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect(await run.result).toMatchObject({
      code: 1,
      signal: null,
      stderr: 'diagnostic',
      error: { code: 1, signal: null },
    });
  });

  it('does not settle a post-spawn error until close and group exit', async () => {
    const run = start();
    child.emit(
      'error',
      Object.assign(new Error('stream failure'), { code: 'EIO' }),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(run.settled).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect(run.settled).not.toHaveBeenCalled();
    child.emit('close', null, 'SIGKILL');
    expect((await run.result).error?.code).toBe('EIO');
  });

  it('handles asynchronous spawn failure without inventing a process group', async () => {
    child.pid = undefined;
    const run = start();
    child.emit(
      'error',
      Object.assign(new Error('not found'), { code: 'ENOENT' }),
    );
    child.emit('close', -2, null);
    expect((await run.result).error?.code).toBe('ENOENT');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('returns a synchronous launch error without ownership or timers', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('invalid launch');
    });
    expect((await start().result).error?.message).toBe('invalid launch');
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not launch an already-cancelled command', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await start({ signal: controller.signal }).result).toMatchObject({
      code: null,
      error: { name: 'AbortError', code: 'ABORT_ERR' },
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects unsupported Windows ownership before launch', async () => {
    mockPlatform.mockReturnValue('win32');
    expect((await start().result).error?.code).toBe(
      'ERR_OWNED_COMMAND_UNSUPPORTED',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('retains active work when inspection is unavailable instead of returning cleanup success', async () => {
    const controller = new AbortController();
    const run = start({ signal: controller.signal });
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    snapshotError = new Error('ps unavailable');
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    expect(run.settled).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    snapshotError = undefined;
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    expect((await run.result).error?.code).toBe('ABORT_ERR');
  });

  it('cleans active groups synchronously on parent exit and removes its listener after drain', async () => {
    const previousListeners = process.listeners('exit');
    const run = start({ timeout: 10000 });
    const cleanup = process
      .listeners('exit')
      .find((listener) => !previousListeners.includes(listener));
    expect(cleanup).toBeDefined();
    cleanup?.(0);
    expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
    child.emit('close', 0, null);
    groupExit();
    await vi.advanceTimersByTimeAsync(100);
    await run.result;
    expect(process.listeners('exit')).toEqual(previousListeners);
    expect(vi.getTimerCount()).toBe(0);
  });
});

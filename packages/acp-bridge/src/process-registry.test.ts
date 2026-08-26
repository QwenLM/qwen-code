/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.hoisted(() => vi.fn());
const mockSpawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mockExecFile,
    spawnSync: mockSpawnSync,
  };
});

import { ProcessRegistry } from './process-registry.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const PS = '/bin/ps';
const TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;

type StringExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

function fakeChild(pid: number | undefined): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockExecFile.mockReset();
  mockSpawnSync.mockReset();
  Object.defineProperty(process, 'platform', originalPlatform);
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: true,
    value: platform,
  });
}

function setAsyncProcessTable(stdout: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[3] as StringExecCallback;
    callback(null, stdout, '');
    return new EventEmitter();
  });
}

function setSyncProcessTable(stdout: string): void {
  mockSpawnSync.mockReturnValue({
    error: undefined,
    status: 0,
    stderr: '',
    stdout,
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('ProcessRegistry', () => {
  it('counts unattached reservations, which is what admission must key on', () => {
    const registry = new ProcessRegistry();
    expect(registry.committedProcessCount).toBe(0);

    // Two spawns racing: both reserve before either attaches. This is the
    // invariant an admission check rests on — `activeProcessCount` shows
    // neither of them yet, so keying off it would let both through.
    const first = registry.reserve();
    const second = registry.reserve();
    expect(registry.activeProcessCount).toBe(0);
    expect(registry.committedProcessCount).toBe(2);

    first.attach(fakeChild(1));
    expect(registry.committedProcessCount).toBe(2);

    // A cancelled reservation releases its slot; leaking it would inflate the
    // count for every later spawn.
    second.cancel();
    expect(registry.committedProcessCount).toBe(1);
    second.cancel();
    expect(registry.committedProcessCount).toBe(1);
  });

  it('releases a committed slot on exit, not when terminate starts', async () => {
    const registry = new ProcessRegistry();
    const child = fakeChild(4321);
    const tracked = registry.reserve().attach(child);
    expect(registry.committedProcessCount).toBe(1);

    // Winding down still occupies the pool: the process is alive and its
    // memory is still resident, so a swap legitimately counts twice.
    const terminating = tracked.terminate();
    await Promise.resolve();
    expect(registry.committedProcessCount).toBe(1);

    child.emit('exit', 0, null);
    await terminating;
    expect(registry.committedProcessCount).toBe(0);
  });

  it('classifies an error without a pid as no process', async () => {
    const registry = new ProcessRegistry();
    const child = fakeChild(undefined);
    const tracked = registry.reserve().attach(child);

    child.emit('error', new Error('ENOENT'));

    await expect(tracked.exited).resolves.toBeUndefined();
    expect(registry.activeProcessCount).toBe(0);
  });

  it('waits for raw exit after a post-spawn error', async () => {
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child);
    let settled = false;
    void tracked.exited.then(() => {
      settled = true;
    });

    child.emit('spawn');
    child.emit('error', new Error('post-spawn transport error'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(registry.activeProcessCount).toBe(1);

    child.emit('exit', 1, null);
    await expect(tracked.exited).resolves.toEqual({
      exitCode: 1,
      signalCode: null,
    });
    expect(registry.activeProcessCount).toBe(0);
  });

  it('uses one TERM/KILL/deadline timeline and fails when exit is unconfirmed', async () => {
    vi.useFakeTimers();
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child);

    const shutdown = registry.shutdown();
    const result = shutdown.catch((error: unknown) => error);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toMatchObject({
      message: 'ACP child process shutdown failed',
    });
    expect(registry.activeProcessCount).toBe(1);
    expect(registry.shutdown()).toBe(shutdown);
  });

  it('reports clean shutdown only after raw exit', async () => {
    vi.useFakeTimers();
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child);

    const shutdown = registry.shutdown();
    child.emit('exit', 0, null);

    await expect(shutdown).resolves.toBeUndefined();
    expect(registry.activeProcessCount).toBe(0);
    expect(() => registry.reserve()).toThrow('draining');
  });

  it('reports an exit caused by the forced SIGKILL as unclean', async () => {
    vi.useFakeTimers();
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child);

    const shutdown = registry.shutdown();
    const result = shutdown.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    child.emit('exit', null, 'SIGKILL');

    await expect(result).resolves.toMatchObject({
      message: 'ACP child process shutdown failed',
    });
    expect(registry.activeProcessCount).toBe(0);
    expect(registry.shutdown()).toBe(shutdown);
  });

  it('terminates every process group discovered in the owned tree', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable(
      ['1234 1 1234', '1235 1234 1234', '1236 1234 1236'].join('\n'),
    );
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    const aliveGroups = new Set([1234, 1236]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') {
        aliveGroups.delete(group);
        if (group === 1234) child.emit('exit', null, 'SIGKILL');
      }
      return true;
    }) as typeof process.kill);

    const terminating = tracked.terminate().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockExecFile).toHaveBeenCalledWith(
      PS,
      ['-A', '-o', 'pid=,ppid=,pgid=,state=,nlwp='],
      expect.objectContaining({ encoding: 'utf8', timeout: 2_000 }),
      expect.any(Function),
    );
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(terminating).resolves.toMatchObject({
      message: expect.stringContaining('exited uncleanly during shutdown'),
    });
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(registry.activeProcessCount).toBe(0);
  });

  it('does not treat root exit as tree teardown completion', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable(['1234 1 1234', '1236 1234 1236'].join('\n'));
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    const aliveGroups = new Set([1234, 1236]);
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGTERM' && group === 1234) {
        aliveGroups.delete(1234);
        child.emit('exit', 0, null);
      }
      if (signal === 'SIGKILL') aliveGroups.delete(group);
      return true;
    }) as typeof process.kill);
    let settled = false;
    const terminating = tracked.terminate().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(registry.activeProcessCount).toBe(1);

    await vi.advanceTimersByTimeAsync(4_000);
    await terminating;
    expect(registry.activeProcessCount).toBe(0);
  });

  it('fails at the total deadline when an owned group survives', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable('1234 1 1234 S 1');
    const registry = new ProcessRegistry();
    const tracked = registry
      .reserve()
      .attach(fakeChild(1234), { ownsProcessTree: true });
    vi.spyOn(process, 'kill').mockReturnValue(true);

    const terminating = tracked.terminate().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(terminating).resolves.toMatchObject({
      message: expect.stringContaining(
        'did not exit with its owned process groups within 10000ms',
      ),
    });
    expect(registry.activeProcessCount).toBe(1);
  });

  it('does not expand ownership from a reused root pid after root exit', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    const processTables = [
      ['1234 1 1234', '1236 1234 1236'].join('\n'),
      ['1234 1 7777', '1236 1 1236'].join('\n'),
    ];
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      callback(null, processTables[mockExecFile.mock.calls.length - 1], '');
      return new EventEmitter();
    });
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    const aliveGroups = new Set([1234, 1236]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGTERM' && group === 1234) {
        aliveGroups.delete(group);
        child.emit('exit', 0, null);
      }
      if (signal === 'SIGKILL') aliveGroups.delete(group);
      return true;
    }) as typeof process.kill);

    const terminating = tracked.terminate();
    await vi.advanceTimersByTimeAsync(5_000);
    await terminating;

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalledWith(-7777, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
  });

  it('force-kills the owned root group after an unexpected root exit', async () => {
    setPlatform('linux');
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child, { ownsProcessTree: true });
    let groupAlive = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) {
        if (!groupAlive) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') groupAlive = false;
      return true;
    }) as typeof process.kill);

    child.emit('exit', 0, null);
    await Promise.resolve();

    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(registry.activeProcessCount).toBe(0);
  });

  it('waits for known groups when termination starts after root exit', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable('1234 1 1234 S 1');
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    let groupAlive = true;
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal) => {
      if (signal === 0 && !groupAlive) throw errno('ESRCH');
      return true;
    }) as typeof process.kill);

    child.emit('exit', 0, null);
    let settled = false;
    const terminating = tracked.terminate().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    expect(registry.activeProcessCount).toBe(1);
    expect(mockExecFile).toHaveBeenCalled();

    groupAlive = false;
    await vi.advanceTimersByTimeAsync(50);
    await terminating;
    expect(registry.activeProcessCount).toBe(0);
  });

  it('releases a Linux process group containing only zombies after escalation', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    const processTables = [
      ['1234 1 1234 S 1', '1236 1234 1236 S 1'].join('\n'),
      ['1234 1 1234 S 1', '1236 1234 1236 S 1'].join('\n'),
      '1236 1 1236 Z 1',
    ];
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      const index = Math.min(
        mockExecFile.mock.calls.length - 1,
        processTables.length - 1,
      );
      callback(null, processTables[index], '');
      return new EventEmitter();
    });
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    const aliveGroups = new Set([1234, 1236]);
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL' && group === 1234) {
        aliveGroups.delete(group);
        child.emit('exit', null, 'SIGKILL');
      }
      return true;
    }) as typeof process.kill);

    const terminating = tracked.terminate().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(terminating).resolves.toMatchObject({
      message: expect.stringContaining('exited uncleanly during shutdown'),
    });
    expect(mockExecFile).toHaveBeenCalledTimes(3);
    expect(registry.activeProcessCount).toBe(0);
  });

  it('releases an unexpectedly exited Linux root whose group is zombie-only', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable('1235 1 1234 Z 1');
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child, { ownsProcessTree: true });
    vi.spyOn(process, 'kill').mockReturnValue(true);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.activeProcessCount).toBe(0);
  });

  it.each([
    ['zombie leader with live threads', '1235 1 1234 Z 2'],
    [
      'zombie group with a live member',
      ['1235 1 1234 Z 1', '1236 1 1234 S 1'].join('\n'),
    ],
  ])('keeps a Linux %s committed', async (_case, processTable) => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable(processTable);
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child, { ownsProcessTree: true });
    let groupAlive = true;
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal) => {
      if (signal === 0 && !groupAlive) throw errno('ESRCH');
      return true;
    }) as typeof process.kill);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.activeProcessCount).toBe(1);

    groupAlive = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(registry.activeProcessCount).toBe(0);
  });

  it('keeps a group committed when its process state cannot be queried', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      callback(errno('EIO'), '', '');
      return new EventEmitter();
    });
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child, { ownsProcessTree: true });
    let groupAlive = true;
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal) => {
      if (signal === 0 && !groupAlive) throw errno('ESRCH');
      return true;
    }) as typeof process.kill);

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(250);
    expect(registry.activeProcessCount).toBe(1);

    groupAlive = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(registry.activeProcessCount).toBe(0);
  });

  it('uses direct-child teardown when a tree-owned child has no pid', async () => {
    const registry = new ProcessRegistry();
    const child = fakeChild(undefined);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });

    const terminating = tracked.terminate();
    child.emit('error', errno('ENOENT'));

    await expect(terminating).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.activeProcessCount).toBe(0);
  });

  it('synchronously snapshots and force-kills owned process groups', () => {
    setPlatform('linux');
    setSyncProcessTable(
      ['1234 1 1234', '1235 1234 1234', '1236 1234 1236'].join('\n'),
    );
    const child = fakeChild(1234);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    tracked.killSync();

    expect(mockSpawnSync).toHaveBeenCalledWith(
      PS,
      ['-A', '-o', 'pid=,ppid=,pgid=,state=,nlwp='],
      expect.objectContaining({ encoding: 'utf8', timeout: 2_000 }),
    );
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('shares one synchronous snapshot across registry force-kills', () => {
    setPlatform('linux');
    setSyncProcessTable(
      ['1234 1 1234', '1236 1234 1236', '2234 1 2234'].join('\n'),
    );
    const registry = new ProcessRegistry();
    const first = registry
      .reserve()
      .attach(fakeChild(1234), { ownsProcessTree: true });
    registry.reserve().attach(fakeChild(2234), { ownsProcessTree: true });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    registry.killAllSync();
    first.killSync();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-2234, 'SIGKILL');
  });

  it('keeps an exited root reachable by registry synchronous teardown', async () => {
    vi.useFakeTimers();
    setPlatform('linux');
    setAsyncProcessTable(['1234 1 1234', '1236 1234 1236'].join('\n'));
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    const tracked = registry.reserve().attach(child, { ownsProcessTree: true });
    const aliveGroups = new Set([1234, 1236]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') aliveGroups.delete(group);
      return true;
    }) as typeof process.kill);

    const terminating = tracked.terminate();
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0, null);

    registry.killAllSync();
    await vi.advanceTimersByTimeAsync(50);
    await terminating;

    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
    expect(registry.activeProcessCount).toBe(0);
  });

  it('rejects a non-leader root in the shared synchronous snapshot', () => {
    setPlatform('linux');
    setSyncProcessTable(['1234 1 999', '1236 1234 1236'].join('\n'));
    const registry = new ProcessRegistry();
    const child = fakeChild(1234);
    registry.reserve().attach(child, { ownsProcessTree: true });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    registry.killAllSync();

    expect(killSpy).not.toHaveBeenCalledWith(-1234, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(-999, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(-1236, expect.anything());
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('falls back to the direct root when its POSIX group signal fails', async () => {
    setPlatform('linux');
    setAsyncProcessTable('1234 1 1234');
    const child = fakeChild(1234);
    vi.mocked(child.kill).mockImplementation(() => {
      child.emit('exit', 0, null);
      return true;
    });
    vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) throw errno('ESRCH');
      throw errno('EPERM');
    }) as typeof process.kill);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    await expect(tracked.terminate()).rejects.toThrow('could not send SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reports an unverified snapshot after applying the root-group fallback', async () => {
    setPlatform('linux');
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      callback(errno('ENOENT'), '', '');
      return new EventEmitter();
    });
    const child = fakeChild(1234);
    let rootAlive = true;
    vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      if (signal === 0) {
        if (!rootAlive) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGTERM') {
        rootAlive = false;
        child.emit('exit', 0, null);
      }
      return true;
    }) as typeof process.kill);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    await expect(tracked.terminate()).rejects.toThrow(
      'process-tree snapshot failed',
    );
  });

  it('does not trust a tree snapshot when the root is not its group leader', async () => {
    setPlatform('linux');
    setAsyncProcessTable(['1234 1 999', '1236 1234 1236'].join('\n'));
    const child = fakeChild(1234);
    vi.mocked(child.kill).mockImplementation(() => {
      child.emit('exit', 0, null);
      return true;
    });
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    await expect(tracked.terminate()).rejects.toThrow(
      'was not an isolated process-group leader',
    );
    expect(killSpy).not.toHaveBeenCalledWith(-1234, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(-999, expect.anything());
    expect(killSpy).not.toHaveBeenCalledWith(-1236, expect.anything());
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not trust an in-flight snapshot after synchronous escalation', async () => {
    setPlatform('linux');
    let finishSnapshot: StringExecCallback | undefined;
    mockExecFile.mockImplementation((...args: unknown[]) => {
      finishSnapshot = args[3] as StringExecCallback;
      return new EventEmitter();
    });
    setSyncProcessTable(['1234 1 1234', '1236 1234 1236'].join('\n'));
    const child = fakeChild(1234);
    const aliveGroups = new Set([1234, 1236]);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      const group = -pid;
      if (signal === 0) {
        if (!aliveGroups.has(group)) throw errno('ESRCH');
        return true;
      }
      if (signal === 'SIGKILL') {
        aliveGroups.delete(group);
        if (group === 1234) child.emit('exit', null, 'SIGKILL');
      }
      return true;
    }) as typeof process.kill);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });
    const terminating = tracked.terminate().catch((error: unknown) => error);

    tracked.killSync();
    finishSnapshot?.(null, ['1234 1 1234', '7776 1234 7777'].join('\n'), '');
    await terminating;

    expect(killSpy).not.toHaveBeenCalledWith(expect.any(Number), 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(-7777, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1236, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('uses the absolute Windows taskkill path for asynchronous teardown', async () => {
    setPlatform('win32');
    const child = fakeChild(1234);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      callback(null, '', '');
      child.emit('exit', 0, null);
      return new EventEmitter();
    });
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    await tracked.terminate();

    expect(mockExecFile).toHaveBeenCalledWith(
      TASKKILL,
      ['/f', '/t', '/pid', '1234'],
      expect.objectContaining({ windowsHide: true, timeout: 2_000 }),
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to the direct child when Windows taskkill fails', async () => {
    setPlatform('win32');
    const child = fakeChild(1234);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const callback = args[3] as StringExecCallback;
      callback(errno('EACCES'), '', '');
      return new EventEmitter();
    });
    vi.mocked(child.kill).mockImplementation(() => {
      child.emit('exit', null, 'SIGKILL');
      return true;
    });
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    await expect(tracked.terminate()).rejects.toThrow(
      'process-tree cleanup failed',
    );
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('uses synchronous Windows taskkill before the direct fallback', () => {
    setPlatform('win32');
    mockSpawnSync.mockReturnValue({
      error: undefined,
      status: 1,
      stderr: '',
      stdout: '',
    });
    const child = fakeChild(1234);
    const tracked = new ProcessRegistry()
      .reserve()
      .attach(child, { ownsProcessTree: true });

    tracked.killSync();
    tracked.killSync();

    expect(mockSpawnSync).toHaveBeenCalledOnce();
    expect(mockSpawnSync).toHaveBeenCalledWith(
      TASKKILL,
      ['/f', '/t', '/pid', '1234'],
      expect.objectContaining({ windowsHide: true, timeout: 2_000 }),
    );
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRegistry } from './process-registry.js';

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
});

describe('ProcessRegistry', () => {
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
});

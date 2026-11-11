/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { runLogger } from '../utils/runLogger.js';
import {
  STARTUP_SLOW_THRESHOLD_MS,
  StartupDiagnostics,
  startupPathKind,
} from './startupDiagnostics.js';

vi.mock('../utils/runLogger.js', () => ({ runLogger: { log: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const events = () => vi.mocked(runLogger.log).mock.calls.map((call) => call[1]);

describe('StartupDiagnostics', () => {
  const diagnostics = new StartupDiagnostics(
    'session',
    String.raw`\\server\share\project`,
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    vi.mocked(runLogger.log).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts immediately, returns the original promise and clears its timer', async () => {
    const task = deferred<object>();
    const action = vi.fn(() => task.promise);
    const observed = diagnostics.phase('memory.refresh', action);
    expect(action).toHaveBeenCalledOnce();
    expect(observed).toBe(task.promise);
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'started',
        name: 'memory.refresh',
        workspace_path_kind: 'unc',
      }),
    ]);
    const value = {};
    task.resolve(value);
    await expect(observed).resolves.toBe(value);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(STARTUP_SLOW_THRESHOLD_MS);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({
      event: 'finished',
      status: 'resolved',
    });
  });

  it('reports a stuck operation only once without settling or cancelling it', async () => {
    const task = deferred<void>();
    let settled = false;
    const observed = diagnostics.operation(
      'memory.discover_paths',
      () => task.promise,
    );
    void observed.then(() => {
      settled = true;
    });
    expect(events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    expect(events()).toEqual([
      expect.objectContaining({
        event: 'still_pending',
        name: 'memory.discover_paths',
        duration_ms: 5_000,
      }),
    ]);
    task.resolve();
    await observed;
    expect(events()[1]).toMatchObject({
      event: 'finished',
      status: 'resolved',
      duration_ms: 120_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not log fast sub-operations or include a private path', async () => {
    await diagnostics.operation('memory.read_contents', () =>
      Promise.resolve(),
    );
    expect(events()).toEqual([]);
    await diagnostics.phase('memory.refresh', () => Promise.resolve());
    expect(JSON.stringify(events())).not.toContain('server');
    expect(JSON.stringify(events())).not.toContain('project');
  });

  it('preserves the exact rejection and clears the timer', async () => {
    const error = new Error('private filename');
    const promise = Promise.reject(error);
    const observed = diagnostics.phase('skills.initialize', () => promise);
    expect(observed).toBe(promise);
    await expect(observed).rejects.toBe(error);
    expect(events()[1]).toMatchObject({
      event: 'finished',
      status: 'rejected',
    });
    expect(JSON.stringify(events())).not.toContain('private filename');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves synchronous exceptions and clears the timer', () => {
    const error = new Error('sync');
    expect(() =>
      diagnostics.phase('memory.refresh', () => {
        throw error;
      }),
    ).toThrow(error);
    expect(events()[1]).toMatchObject({
      event: 'finished',
      status: 'rejected',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let logging failures change success, failure or pending tasks', async () => {
    vi.mocked(runLogger.log).mockImplementation(() => {
      throw new Error('writer failed');
    });
    const task = deferred<void>();
    const observed = diagnostics.phase('memory.refresh', () => task.promise);
    await vi.advanceTimersByTimeAsync(STARTUP_SLOW_THRESHOLD_MS);
    task.resolve();
    await expect(observed).resolves.toBeUndefined();
    const error = new Error('original');
    await expect(
      diagnostics.phase('skills.initialize', () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('measures execution separately from the later remaining wait', async () => {
    const task = deferred<void>();
    diagnostics.phase('skills.initialize', () => task.promise);
    await vi.advanceTimersByTimeAsync(2_000);
    diagnostics.phase('skills.wait', () => task.promise);
    await vi.advanceTimersByTimeAsync(1_000);
    task.resolve();
    await task.promise;
    expect(events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'finished',
          name: 'skills.initialize',
          duration_ms: 3_000,
        }),
        expect.objectContaining({
          event: 'finished',
          name: 'skills.wait',
          duration_ms: 1_000,
        }),
      ]),
    );
  });

  it('unrefs the diagnostic timer', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await diagnostics.phase('memory.refresh', () => Promise.resolve());
    const timer = spy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
  });

  it('adds described result attributes to the finished record and observation', async () => {
    const observer = vi.fn();
    const observed = new StartupDiagnostics('session', '/repo', observer);
    const result = { outcome: 'budget_exhausted', pending: 2 };
    await expect(
      observed.phase(
        'mcp.wait',
        () => Promise.resolve(result),
        (value) => ({ outcome: value.outcome, pending_after: value.pending, event: 'spoofed' }),
      ),
    ).resolves.toBe(result);
    expect(events()[1]).toMatchObject({
      event: 'finished',
      name: 'mcp.wait',
      outcome: 'budget_exhausted',
      pending_after: 2,
    });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'mcp.wait',
        status: 'resolved',
        attrs: { outcome: 'budget_exhausted', pending_after: 2, event: 'spoofed' },
      }),
    );
  });

  it('ignores describe failures', async () => {
    const value = {};
    await expect(
      diagnostics.phase('mcp.wait', () => Promise.resolve(value), () => {
        throw new Error('describe failed');
      }),
    ).resolves.toBe(value);
    expect(events()[1]).toMatchObject({ event: 'finished', status: 'resolved' });
  });

  it('does not describe a rejected task', async () => {
    const describe = vi.fn(() => ({}));
    const error = new Error('failed');
    await expect(
      diagnostics.phase('mcp.wait', () => Promise.reject(error), describe),
    ).rejects.toBe(error);
    expect(describe).not.toHaveBeenCalled();
  });
});

describe('startupPathKind', () => {
  it.each([
    [String.raw`\\host\share\project`, 'unc'],
    ['//host/share/project', 'unc'],
    [String.raw`\\?\UNC\host\share\project`, 'unc'],
    [String.raw`\\?\C:\project`, 'windows_drive'],
    [String.raw`Z:\project`, 'windows_drive'],
    ['/mnt/network/project', 'posix'],
    ['relative/path', 'other'],
  ])('classifies %s lexically as %s', (value, expected) => {
    expect(startupPathKind(value)).toBe(expected);
  });
});

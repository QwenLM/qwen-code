/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StartupRuntime,
  startupTaskId,
  type StartupDegradation,
} from './startupRuntime.js';

describe('StartupRuntime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a gate pending until its dependencies are ready', async () => {
    const runtime = new StartupRuntime({
      gates: ['base', 'memory'] as const,
      dependencies: {
        memory: ['base'],
      },
    });

    let resolved = false;
    const waitForMemory = runtime.when('memory').then((result) => {
      resolved = true;
      return result;
    });

    runtime.markReady('memory');
    await Promise.resolve();
    expect(resolved).toBe(false);

    runtime.markReady('base');
    await expect(waitForMemory).resolves.toEqual({ status: 'ready' });
    expect(resolved).toBe(true);
  });

  it('records the first monotonic start and settle times without changing snapshots', () => {
    const runtime = new StartupRuntime({ gates: ['base'] as const });

    expect(runtime.getStartedElapsedMs('base')).toBeUndefined();
    expect(runtime.getSettledElapsedMs('base')).toBeUndefined();
    runtime.markStarted('base');
    const firstStartedAt = runtime.getStartedElapsedMs('base');
    runtime.markStarted('base');
    runtime.markDegraded('base', {
      code: 'auth-degraded',
      message: 'using cached auth',
    });
    const firstSettledAt = runtime.getSettledElapsedMs('base');
    runtime.markReady('base');

    expect(firstStartedAt).toEqual(expect.any(Number));
    expect(runtime.getStartedElapsedMs('base')).toBe(firstStartedAt);
    expect(firstSettledAt).toEqual(expect.any(Number));
    expect(firstSettledAt).toBeGreaterThanOrEqual(firstStartedAt ?? 0);
    expect(runtime.getSettledElapsedMs('base')).toBe(firstSettledAt);
    expect(runtime.snapshot().base).toEqual({ status: 'ready', reasons: [] });

    runtime.reset('base');
    expect(runtime.getStartedElapsedMs('base')).toBeUndefined();
    expect(runtime.getSettledElapsedMs('base')).toBeUndefined();
  });

  it('propagates dependency degradation to dependent gates', async () => {
    const runtime = new StartupRuntime({
      gates: ['base', 'commands'] as const,
      dependencies: {
        commands: ['base'],
      },
    });
    const reason: StartupDegradation = {
      code: 'skills-discovery-failed',
      message: 'skills unavailable',
    };

    runtime.markDegraded('base', reason);
    runtime.markReady('commands');

    await expect(runtime.when('commands')).resolves.toEqual({
      status: 'degraded',
      reasons: [reason],
    });
  });

  it('clears a degraded snapshot when a gate later becomes fully ready', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const reason: StartupDegradation = {
      code: 'mcp-budget-timeout',
      message: 'MCP budget elapsed',
    };

    runtime.markDegraded('base', reason);
    expect(runtime.snapshot().base).toEqual({
      status: 'degraded',
      reasons: [reason],
    });

    runtime.markReady('base');
    expect(runtime.snapshot().base).toEqual({
      status: 'ready',
      reasons: [],
    });
    await expect(runtime.when('base')).resolves.toEqual({ status: 'ready' });
  });

  it('keeps distinct degradation reasons for the same gate', () => {
    const runtime = new StartupRuntime({
      gates: ['commands'] as const,
    });
    const discoveryReason: StartupDegradation = {
      code: 'skills-discovery-failed',
      message: 'skill discovery boom',
    };
    const replayReason: StartupDegradation = {
      code: 'skills-emit-failed',
      message: 'skill emit boom',
    };

    runtime.markDegraded('commands', discoveryReason);
    runtime.markDegraded('commands', replayReason);
    runtime.markDegraded('commands', discoveryReason);

    expect(runtime.snapshot().commands).toEqual({
      status: 'degraded',
      reasons: [discoveryReason, replayReason],
    });
  });

  it('rejects dependent gate waiters when a dependency fails', async () => {
    const runtime = new StartupRuntime({
      gates: ['base', 'commands'] as const,
      dependencies: {
        commands: ['base'],
      },
    });
    const waitForCommands = runtime.when('commands');

    runtime.markFailed('base', {
      code: 'config-initialization-failed',
      message: 'base boom',
    });

    await expect(waitForCommands).rejects.toThrow('base boom');
  });

  it('replays onReady for late subscribers without duplicating future updates', async () => {
    const runtime = new StartupRuntime({
      gates: ['base', 'commands'] as const,
      dependencies: {
        commands: ['base'],
      },
    });
    runtime.markReady('base');
    runtime.markReady('commands');

    const listener = vi.fn();
    runtime.onReady('commands', listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ status: 'ready' });

    runtime.markReady('base');
    runtime.markReady('commands');
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies onReady subscribers when a degraded gate later becomes ready', () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const listener = vi.fn();
    runtime.onReady('base', listener);

    runtime.markDegraded('base', {
      code: 'mcp-budget-timeout',
      message: 'MCP budget elapsed',
    });
    runtime.markReady('base');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, {
      status: 'degraded',
      reasons: [
        {
          code: 'mcp-budget-timeout',
          message: 'MCP budget elapsed',
        },
      ],
    });
    expect(listener).toHaveBeenNthCalledWith(2, { status: 'ready' });
  });

  it('does not replay stale onReady state after a synchronous update', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const reason: StartupDegradation = {
      code: 'mcp-budget-timeout',
      message: 'MCP budget elapsed',
    };
    runtime.markReady('base');

    const listener = vi.fn();
    runtime.onReady('base', listener);
    runtime.markDegraded('base', reason);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      status: 'degraded',
      reasons: [reason],
    });
  });

  it('debounces repeated change events at the runtime boundary', () => {
    vi.useFakeTimers();
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
      changeDebounceMs: 150,
    });
    const listener = vi.fn();
    runtime.onChange('commands', listener);

    runtime.emitChange('commands');
    runtime.emitChange('commands');
    vi.advanceTimersByTime(149);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('delivers change events under a sustained burst after max wait', () => {
    vi.useFakeTimers();
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
      changeDebounceMs: 100,
      changeMaxWaitMs: 250,
    });
    const listener = vi.fn();
    runtime.onChange('mcp', listener);

    runtime.emitChange('mcp');
    vi.advanceTimersByTime(90);
    runtime.emitChange('mcp');
    vi.advanceTimersByTime(90);
    runtime.emitChange('mcp');
    vi.advanceTimersByTime(69);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('deduplicates keyed tasks owned by a runtime instance', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const task = vi.fn(async () => 'done');

    await expect(
      Promise.all([
        runtime.runOnce(startupTaskId<string>('probe'), task),
        runtime.runOnce(startupTaskId<string>('probe'), task),
      ]),
    ).resolves.toEqual(['done', 'done']);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('keeps rejected keyed tasks cached', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const task = vi.fn(async () => {
      throw new Error('probe boom');
    });

    const taskId = startupTaskId<never>('probe');
    await expect(runtime.runOnce(taskId, task)).rejects.toThrow('probe boom');
    await expect(runtime.runOnce(taskId, task)).rejects.toThrow('probe boom');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('runs keyed tasks after a readiness gate becomes ready', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const task = vi.fn(async () => 'started');

    const taskPromise = runtime.runOnceWhenReady(
      'base',
      { taskId: startupTaskId<string>('post-config') },
      task,
    );
    await Promise.resolve();
    expect(task).not.toHaveBeenCalled();

    runtime.markReady('base');
    await expect(taskPromise).resolves.toBe('started');
    expect(task).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('does not cache aborted runOnceWhenReady gate waits', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const task = vi.fn(async () => 'started');
    const taskId = startupTaskId<string>('post-config');
    const controller = new AbortController();

    const abortedTask = runtime.runOnceWhenReady(
      'base',
      { taskId, signal: controller.signal },
      task,
    );
    controller.abort();

    await expect(abortedTask).rejects.toMatchObject({ name: 'AbortError' });
    expect(task).not.toHaveBeenCalled();

    runtime.markReady('base');
    await expect(
      runtime.runOnceWhenReady('base', { taskId }, task),
    ).resolves.toBe('started');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('replays completed keyed tasks after dispose', async () => {
    const runtime = new StartupRuntime({
      gates: ['base'] as const,
    });
    const task = vi.fn(async () => 'flushed');
    const taskId = startupTaskId<string>('flush-stats');

    await expect(runtime.runOnce(taskId, task)).resolves.toBe('flushed');
    runtime.dispose();
    await expect(runtime.runOnce(taskId, task)).resolves.toBe('flushed');
    expect(task).toHaveBeenCalledTimes(1);
  });
});

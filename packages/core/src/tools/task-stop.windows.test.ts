/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { wrapSpawn } from '../utils/ShellCommand.js';
import { runLogger } from '../utils/runLogger.js';
import { spawnAsync } from '../utils/shell-utils.js';
import { TaskStopTool } from './task-stop.js';

vi.mock('../utils/shell-utils.js', () => ({ spawnAsync: vi.fn() }));

function createFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 45678,
    stdin: null,
    stdout: null,
    stderr: null,
    exitCode: null,
    signalCode: null,
  }) as ChildProcess;
  const command = wrapSpawn(child, new AbortController().signal, 0);
  command.background('test-task');
  const registry = new TaskRegistry();
  registry.register({
    id: 'b-test-task',
    publicId: 'test-task',
    sessionId: 'test-session',
    type: 'local_bash',
    status: 'running',
    description: 'bounded fixture',
    startTime: Date.now(),
    notified: false,
    executionId: child.pid!,
    completionBehavior: 'silent',
    command: 'sleep 5 | head',
    isBackgrounded: true,
    output: '',
  });
  ExecutionLifecycleService.attachExecution(child.pid!, {
    executionMethod: 'child_process',
    kill: () => command.kill(),
    isActive: () => command.status === 'backgrounded',
  });
  const config = {
    taskRegistry: registry,
    getSessionId: () => 'test-session',
  } as unknown as Config;
  const stop = () => {
    const tool = new TaskStopTool(config);
    // @ts-expect-error Exercise the real invocation without parameter parsing.
    const invocation = tool.createInvocation({ task_id: 'test-task' });
    return invocation.execute(new AbortController().signal);
  };
  return { child, command, registry, stop };
}

describe('Windows TaskStop termination failures', () => {
  beforeEach(() => {
    ExecutionLifecycleService.resetForTest();
    vi.useFakeTimers();
    vi.mocked(spawnAsync).mockReset();
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    ExecutionLifecycleService.resetForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not delay or retry a successful first taskkill', async () => {
    const { command, stop } = createFixture();
    vi.mocked(spawnAsync).mockResolvedValue({ stdout: '', stderr: '' });
    try {
      const stopped = await stop();
      expect(stopped.error).toBeUndefined();
      expect(stopped.llmContent).toContain('Successfully stopped');
      await vi.advanceTimersByTimeAsync(2000);
      expect(spawnAsync).toHaveBeenCalledTimes(1);
    } finally {
      command.cleanup();
    }
  });

  it('waits 1500ms after failure and succeeds on a single shared retry', async () => {
    const { command, stop } = createFixture();
    vi.mocked(spawnAsync)
      .mockRejectedValueOnce(new Error('taskkill exited with code 1'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    try {
      let settled = false;
      const stopping = stop().then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(spawnAsync).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      const sameKill = command.kill();
      expect(command.kill()).toBe(sameKill);
      await vi.advanceTimersByTimeAsync(1);
      const result = await stopping;
      await sameKill;
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Successfully stopped');
      expect(spawnAsync).toHaveBeenCalledTimes(2);
      expect(runLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('attempt=1/2'),
      );
    } finally {
      command.cleanup();
    }
  });

  it('returns the second failure, logs both attempts, and retains the task for a later stop', async () => {
    const { child, command, registry, stop } = createFixture();
    vi.mocked(spawnAsync)
      .mockRejectedValueOnce(new Error('taskkill ENOENT'))
      .mockRejectedValueOnce(
        new Error('Command failed with exit code 5: Access is denied'),
      );
    try {
      const stopping = stop();
      await vi.advanceTimersByTimeAsync(1500);
      const failed = await stopping;
      expect(failed.error?.message).toContain('exit code 5: Access is denied');
      expect(failed.llmContent).not.toContain('Successfully stopped');
      expect(command.status).toBe('backgrounded');
      expect(ExecutionLifecycleService.isActive(child.pid!)).toBe(true);
      expect(registry.get('b-test-task')?.status).toBe('running');
      expect(runLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('attempt=1/2'),
      );
      expect(runLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('attempt=2/2'),
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawnAsync).toHaveBeenCalledTimes(2);

      vi.mocked(spawnAsync).mockResolvedValueOnce({ stdout: '', stderr: '' });
      const stopped = await stop();
      expect(stopped.error).toBeUndefined();
      expect(spawnAsync).toHaveBeenCalledTimes(3);
      expect(ExecutionLifecycleService.isActive(child.pid!)).toBe(false);
    } finally {
      command.cleanup();
    }
  });

  it('does not retry an old PID when the original child exits during the delay', async () => {
    const { child, command, stop } = createFixture();
    vi.mocked(spawnAsync).mockRejectedValue(new Error('first stop failed'));
    try {
      const stopping = stop();
      await vi.advanceTimersByTimeAsync(500);
      child.emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(1000);
      const failed = await stopping;
      expect(failed.error?.message).toContain('first stop failed');
      expect(spawnAsync).toHaveBeenCalledTimes(1);
      expect(runLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('termination retry skipped'),
      );
    } finally {
      command.cleanup();
    }
  });
});

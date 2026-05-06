/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStopTool } from './task-stop.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { BackgroundShellRegistry } from '../services/backgroundShellRegistry.js';
import { MonitorRegistry } from '../services/monitorRegistry.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

describe('TaskStopTool', () => {
  let registry: BackgroundTaskRegistry;
  let shellRegistry: BackgroundShellRegistry;
  let monitorRegistry: MonitorRegistry;
  let config: Config;
  let tool: TaskStopTool;
  let abandonBackgroundAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    abandonBackgroundAgent = vi.fn();
    shellRegistry = new BackgroundShellRegistry();
    monitorRegistry = new MonitorRegistry();
    // Default fake MemoryManager — every test that doesn't care about
    // dream gets an empty stub so the 4th-route lookup falls through to
    // the not-found branch instead of crashing on undefined.
    const memoryManager = {
      getTask: vi.fn(() => undefined),
      cancelTask: vi.fn(() => false),
    };
    config = {
      getBackgroundTaskRegistry: () => registry,
      abandonBackgroundAgent,
      getBackgroundShellRegistry: () => shellRegistry,
      getMonitorRegistry: () => monitorRegistry,
      getMemoryManager: () => memoryManager,
    } as unknown as Config;
    tool = new TaskStopTool(config);
  });

  it('cancels a running agent', async () => {
    const ac = new AbortController();
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: ac,
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1' },
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancellation requested');
    expect(result.llmContent).toContain('agent-1');
    expect(registry.get('agent-1')!.status).toBe('cancelled');
    expect(ac.signal.aborted).toBe(true);
  });

  it('returns error for non-existent task', async () => {
    const result = await tool.validateBuildAndExecute(
      { task_id: 'nope' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
  });

  it('returns error for non-running task', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });
    registry.complete('agent-1', 'done');

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
    expect(result.llmContent).toContain('not running');
  });

  it('includes description in success response', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'Search for auth code',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1' },
      new AbortController().signal,
    );

    expect(result.llmContent).toContain('Search for auth code');
    expect(result.returnDisplay).toContain('Search for auth code');
  });

  it('cancels a paused agent through the resume service', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'Paused agent',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
    });
    abandonBackgroundAgent.mockReturnValue(true);

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1' },
      new AbortController().signal,
    );

    expect(abandonBackgroundAgent).toHaveBeenCalledWith('agent-1');
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancelled paused background agent');
  });

  describe('background shell support', () => {
    it('cancels a running background shell', async () => {
      const ac = new AbortController();
      shellRegistry.register({
        shellId: 'bg_a1b2c3d4',
        command: 'npm run dev',
        cwd: '/work',
        status: 'running',
        startTime: Date.now(),
        outputPath: '/tmp/bg-out/shell-bg_a1b2c3d4.output',
        abortController: ac,
      });

      const result = await tool.validateBuildAndExecute(
        { task_id: 'bg_a1b2c3d4' },
        new AbortController().signal,
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('background shell "bg_a1b2c3d4"');
      expect(result.llmContent).toContain('npm run dev');
      expect(result.llmContent).toContain(
        '/tmp/bg-out/shell-bg_a1b2c3d4.output',
      );
      // task_stop only requests cancellation — the entry stays `running`
      // until the spawn handler observes the abort and settles the entry
      // with the real exit moment. Without this guarantee, /tasks would
      // report a terminal-but-still-draining shell.
      expect(shellRegistry.get('bg_a1b2c3d4')!.status).toBe('running');
      expect(shellRegistry.get('bg_a1b2c3d4')!.endTime).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
    });

    it('returns NOT_RUNNING when the shell already exited', async () => {
      shellRegistry.register({
        shellId: 'bg_done',
        command: 'true',
        cwd: '/work',
        status: 'running',
        startTime: Date.now() - 1000,
        outputPath: '/tmp/bg-out/shell-bg_done.output',
        abortController: new AbortController(),
      });
      shellRegistry.complete('bg_done', 0, Date.now());

      const result = await tool.validateBuildAndExecute(
        { task_id: 'bg_done' },
        new AbortController().signal,
      );

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background shell "bg_done"');
      expect(result.llmContent).toContain('completed');
    });

    it('prefers an agent over a shell when both have the same id (defensive)', async () => {
      // IDs cannot collide in practice (different naming schemes), but the
      // tool's lookup order should still be deterministic if they ever do.
      const agentAc = new AbortController();
      const shellAc = new AbortController();
      registry.register({
        agentId: 'shared-id',
        description: 'agent',
        status: 'running',
        startTime: Date.now(),
        abortController: agentAc,
      });
      shellRegistry.register({
        shellId: 'shared-id',
        command: 'shell-cmd',
        cwd: '/work',
        status: 'running',
        startTime: Date.now(),
        outputPath: '/tmp/x.out',
        abortController: shellAc,
      });

      const result = await tool.validateBuildAndExecute(
        { task_id: 'shared-id' },
        new AbortController().signal,
      );

      expect(result.llmContent).toContain('background agent');
      expect(agentAc.signal.aborted).toBe(true);
      expect(shellAc.signal.aborted).toBe(false);
      expect(shellRegistry.get('shared-id')!.status).toBe('running');
    });
  });

  describe('monitor support', () => {
    it('cancels a running monitor', async () => {
      const ac = new AbortController();
      monitorRegistry.register({
        monitorId: 'mon_123',
        command: 'tail -f app.log',
        description: 'watch app log',
        status: 'running',
        startTime: Date.now(),
        abortController: ac,
        eventCount: 0,
        lastEventTime: 0,
        maxEvents: 100,
        idleTimeoutMs: 300_000,
        droppedLines: 0,
      });

      const result = await tool.validateBuildAndExecute(
        { task_id: 'mon_123' },
        new AbortController().signal,
      );

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Monitor "mon_123" cancelled');
      expect(result.llmContent).toContain('tail -f app.log');
      expect(result.returnDisplay).toContain('watch app log');
      expect(monitorRegistry.get('mon_123')!.status).toBe('cancelled');
      expect(ac.signal.aborted).toBe(true);
    });

    it('returns NOT_RUNNING when the monitor already completed', async () => {
      monitorRegistry.register({
        monitorId: 'mon_done',
        command: 'true',
        description: 'completed monitor',
        status: 'running',
        startTime: Date.now() - 1000,
        abortController: new AbortController(),
        eventCount: 0,
        lastEventTime: 0,
        maxEvents: 100,
        idleTimeoutMs: 300_000,
        droppedLines: 0,
      });
      monitorRegistry.complete('mon_done', 0);

      const result = await tool.validateBuildAndExecute(
        { task_id: 'mon_done' },
        new AbortController().signal,
      );

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background monitor "mon_done"');
      expect(result.llmContent).toContain('completed');
    });
  });

  describe('dream task support', () => {
    it('cancels a running dream by routing through MemoryManager.cancelTask', async () => {
      const cancelTask = vi.fn(() => true);
      const dreamRecord = {
        id: 'dream-running-1',
        taskType: 'dream' as const,
        projectRoot: '/p',
        status: 'running' as const,
        createdAt: '2026-05-04T12:00:00.000Z',
        updatedAt: '2026-05-04T12:00:00.000Z',
      };
      const memoryManager = {
        getTask: vi.fn((id: string) =>
          id === 'dream-running-1' ? dreamRecord : undefined,
        ),
        cancelTask,
      };
      const localConfig = {
        getBackgroundTaskRegistry: () => registry,
        abandonBackgroundAgent,
        getBackgroundShellRegistry: () => shellRegistry,
        getMonitorRegistry: () => monitorRegistry,
        getMemoryManager: () => memoryManager,
      } as unknown as Config;
      const localTool = new TaskStopTool(localConfig);

      const result = await localTool.validateBuildAndExecute(
        { task_id: 'dream-running-1' },
        new AbortController().signal,
      );

      expect(cancelTask).toHaveBeenCalledWith('dream-running-1');
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Cancellation requested');
      expect(result.llmContent).toContain('dream task "dream-running-1"');
    });

    it('returns NOT_RUNNING when the dream is already terminal', async () => {
      // Mirrors the agent / shell / monitor not-running guards so a
      // model retry against an already-finished dream surfaces the
      // distinct error type instead of "not found".
      const dreamRecord = {
        id: 'dream-done-1',
        taskType: 'dream' as const,
        projectRoot: '/p',
        status: 'completed' as const,
        createdAt: '2026-05-04T12:00:00.000Z',
        updatedAt: '2026-05-04T12:01:00.000Z',
      };
      const cancelTask = vi.fn(() => false);
      const memoryManager = {
        getTask: vi.fn(() => dreamRecord),
        cancelTask,
      };
      const localConfig = {
        getBackgroundTaskRegistry: () => registry,
        abandonBackgroundAgent,
        getBackgroundShellRegistry: () => shellRegistry,
        getMonitorRegistry: () => monitorRegistry,
        getMemoryManager: () => memoryManager,
      } as unknown as Config;
      const localTool = new TaskStopTool(localConfig);

      const result = await localTool.validateBuildAndExecute(
        { task_id: 'dream-done-1' },
        new AbortController().signal,
      );

      expect(cancelTask).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background dream "dream-done-1"');
      expect(result.llmContent).toContain('completed');
    });

    it('returns NOT_CANCELLABLE when the task id resolves to an extract record', async () => {
      // Extract is short-lived and runs on the request path; cancelling
      // it would interfere with the user's own turn. The dispatch must
      // distinguish "task exists but isn't cancellable" from "task
      // doesn't exist" — without the distinct error type, a model
      // retrying against an extract id would incorrectly conclude the
      // id was never valid.
      const extractRecord = {
        id: 'extract-running-1',
        taskType: 'extract' as const,
        projectRoot: '/p',
        status: 'running' as const,
        createdAt: '2026-05-04T12:00:00.000Z',
        updatedAt: '2026-05-04T12:00:00.000Z',
      };
      const cancelTask = vi.fn();
      const memoryManager = {
        getTask: vi.fn(() => extractRecord),
        cancelTask,
      };
      const localConfig = {
        getBackgroundTaskRegistry: () => registry,
        abandonBackgroundAgent,
        getBackgroundShellRegistry: () => shellRegistry,
        getMonitorRegistry: () => monitorRegistry,
        getMemoryManager: () => memoryManager,
      } as unknown as Config;
      const localTool = new TaskStopTool(localConfig);

      const result = await localTool.validateBuildAndExecute(
        { task_id: 'extract-running-1' },
        new AbortController().signal,
      );

      expect(cancelTask).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_CANCELLABLE);
      expect(result.llmContent).toContain('extract');
      expect(result.llmContent).toContain('not cancellable');
    });

    it('returns an error when cancelTask returns false (missing AbortController)', async () => {
      // The MemoryManager.cancelTask contract returns false when the
      // AbortController is missing for a running record — a logic-
      // level invariant violation. task_stop must surface the failure
      // rather than report a phantom success, otherwise the model
      // believes the dream is being aborted while it actually keeps
      // burning tokens.
      const dreamRecord = {
        id: 'dream-broken-1',
        taskType: 'dream' as const,
        projectRoot: '/p',
        status: 'running' as const,
        createdAt: '2026-05-04T12:00:00.000Z',
        updatedAt: '2026-05-04T12:00:00.000Z',
      };
      const memoryManager = {
        getTask: vi.fn(() => dreamRecord),
        cancelTask: vi.fn(() => false),
      };
      const localConfig = {
        getBackgroundTaskRegistry: () => registry,
        abandonBackgroundAgent,
        getBackgroundShellRegistry: () => shellRegistry,
        getMonitorRegistry: () => monitorRegistry,
        getMemoryManager: () => memoryManager,
      } as unknown as Config;
      const localTool = new TaskStopTool(localConfig);

      const result = await localTool.validateBuildAndExecute(
        { task_id: 'dream-broken-1' },
        new AbortController().signal,
      );

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_INTERNAL_ERROR);
      expect(result.llmContent).toContain('could not be cancelled');
    });
  });
});

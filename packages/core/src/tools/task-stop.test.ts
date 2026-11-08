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

/** A MemoryManager task record; `updatedAt` defaults to `createdAt`. */
const memoryTask = (fields: {
  id: string;
  taskType: 'dream' | 'extract';
  status: 'running' | 'completed';
  updatedAt?: string;
}) => ({
  id: fields.id,
  taskType: fields.taskType,
  projectRoot: '/p',
  status: fields.status,
  createdAt: '2026-05-04T12:00:00.000Z',
  updatedAt: fields.updatedAt ?? '2026-05-04T12:00:00.000Z',
});

describe('TaskStopTool', () => {
  let registry: BackgroundTaskRegistry;
  let shellRegistry: BackgroundShellRegistry;
  let monitorRegistry: MonitorRegistry;
  let tool: TaskStopTool;
  let abandonBackgroundAgent: ReturnType<typeof vi.fn>;

  const makeTool = (memoryManager: object) =>
    new TaskStopTool({
      getBackgroundTaskRegistry: () => registry,
      abandonBackgroundAgent,
      getBackgroundShellRegistry: () => shellRegistry,
      getMonitorRegistry: () => monitorRegistry,
      getMemoryManager: () => memoryManager,
    } as unknown as Config);
  const stop = (taskId: string, stopTool = tool) =>
    stopTool.validateBuildAndExecute(
      { task_id: taskId },
      new AbortController().signal,
    );
  const registerAgent = ({
    agentId = 'agent-1',
    description = 'test agent',
    status = 'running' as 'running' | 'paused',
    abortController = new AbortController(),
  }) =>
    registry.register({
      agentId,
      description,
      status,
      startTime: Date.now(),
      abortController,
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
  const registerShell = (fields: {
    shellId: string;
    command: string;
    startTime: number;
    outputPath: string;
    abortController: AbortController;
  }) => shellRegistry.register({ ...fields, cwd: '/work', status: 'running' });
  const registerMonitor = (fields: {
    monitorId: string;
    command: string;
    description: string;
    startTime: number;
    abortController: AbortController;
  }) =>
    monitorRegistry.register({
      ...fields,
      status: 'running',
      eventCount: 0,
      lastEventTime: 0,
      maxEvents: 100,
      idleTimeoutMs: 300_000,
      droppedLines: 0,
      outputFile: '/tmp/test.jsonl',
    });

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    abandonBackgroundAgent = vi.fn();
    shellRegistry = new BackgroundShellRegistry();
    monitorRegistry = new MonitorRegistry();
    // Default empty MemoryManager stub, so the 4th-route (dream) lookup
    // falls through to not-found instead of crashing on undefined.
    tool = makeTool({
      getTask: vi.fn(() => undefined),
      cancelTask: vi.fn(() => false),
    });
  });

  it('cancels a running agent', async () => {
    const ac = new AbortController();
    registerAgent({ abortController: ac });

    const result = await stop('agent-1');

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancellation requested');
    expect(result.llmContent).toContain('agent-1');
    expect(registry.get('agent-1')!.status).toBe('cancelled');
    expect(ac.signal.aborted).toBe(true);
  });

  it('returns error for non-existent task', async () => {
    const result = await stop('nope');

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
  });

  it('returns error for non-running task', async () => {
    registerAgent({});
    registry.complete('agent-1', 'done');

    const result = await stop('agent-1');

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
    expect(result.llmContent).toContain('not running');
  });

  it('includes description in success response', async () => {
    registerAgent({ description: 'Search for auth code' });

    const result = await stop('agent-1');

    expect(result.llmContent).toContain('Search for auth code');
    expect(result.returnDisplay).toContain('Search for auth code');
  });

  it('cancels a paused agent through the resume service', async () => {
    registerAgent({ description: 'Paused agent', status: 'paused' });
    abandonBackgroundAgent.mockReturnValue(true);

    const result = await stop('agent-1');

    expect(abandonBackgroundAgent).toHaveBeenCalledWith('agent-1');
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Cancelled paused background agent');
  });

  describe('background shell support', () => {
    it('cancels a running background shell', async () => {
      const ac = new AbortController();
      registerShell({
        shellId: 'bg_a1b2c3d4',
        command: 'npm run dev',
        startTime: Date.now(),
        outputPath: '/tmp/bg-out/shell-bg_a1b2c3d4.output',
        abortController: ac,
      });

      const result = await stop('bg_a1b2c3d4');

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('background shell "bg_a1b2c3d4"');
      expect(result.llmContent).toContain('npm run dev');
      expect(result.llmContent).toContain(
        '/tmp/bg-out/shell-bg_a1b2c3d4.output',
      );
      // task_stop only requests cancellation: the entry stays `running` until
      // the spawn handler observes the abort and settles it with the real exit
      // moment. Otherwise /tasks would report a terminal-but-draining shell.
      expect(shellRegistry.get('bg_a1b2c3d4')!.status).toBe('running');
      expect(shellRegistry.get('bg_a1b2c3d4')!.endTime).toBeUndefined();
      expect(ac.signal.aborted).toBe(true);
    });

    it('returns NOT_RUNNING when the shell already exited', async () => {
      registerShell({
        shellId: 'bg_done',
        command: 'true',
        startTime: Date.now() - 1000,
        outputPath: '/tmp/bg-out/shell-bg_done.output',
        abortController: new AbortController(),
      });
      shellRegistry.complete('bg_done', 0, Date.now());

      const result = await stop('bg_done');

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background shell "bg_done"');
      expect(result.llmContent).toContain('completed');
    });

    it('prefers an agent over a shell when both have the same id (defensive)', async () => {
      // IDs cannot collide in practice (different naming schemes), but the
      // tool's lookup order should still be deterministic if they ever do.
      const agentAc = new AbortController();
      const shellAc = new AbortController();
      registerAgent({
        agentId: 'shared-id',
        description: 'agent',
        abortController: agentAc,
      });
      registerShell({
        shellId: 'shared-id',
        command: 'shell-cmd',
        startTime: Date.now(),
        outputPath: '/tmp/x.out',
        abortController: shellAc,
      });

      const result = await stop('shared-id');

      expect(result.llmContent).toContain('background agent');
      expect(agentAc.signal.aborted).toBe(true);
      expect(shellAc.signal.aborted).toBe(false);
      expect(shellRegistry.get('shared-id')!.status).toBe('running');
    });
  });

  describe('monitor support', () => {
    it('cancels a running monitor', async () => {
      const ac = new AbortController();
      const notificationCallback = vi.fn();
      monitorRegistry.setNotificationCallback(notificationCallback);
      registerMonitor({
        monitorId: 'mon_123',
        command: 'tail -f app.log',
        description: 'watch app log',
        startTime: Date.now(),
        abortController: ac,
      });

      const result = await stop('mon_123');

      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Monitor "mon_123" cancelled');
      expect(result.llmContent).toContain('tail -f app.log');
      expect(result.returnDisplay).toContain('watch app log');
      expect(monitorRegistry.get('mon_123')!.status).toBe('cancelled');
      expect(ac.signal.aborted).toBe(true);
      expect(notificationCallback).not.toHaveBeenCalled();
    });

    it('returns NOT_RUNNING when the monitor already completed', async () => {
      registerMonitor({
        monitorId: 'mon_done',
        command: 'true',
        description: 'completed monitor',
        startTime: Date.now() - 1000,
        abortController: new AbortController(),
      });
      monitorRegistry.complete('mon_done', 0);

      const result = await stop('mon_done');

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background monitor "mon_done"');
      expect(result.llmContent).toContain('completed');
    });
  });

  describe('dream task support', () => {
    it('cancels a running dream by routing through MemoryManager.cancelTask', async () => {
      const cancelTask = vi.fn(() => true);
      const dreamRecord = memoryTask({
        id: 'dream-running-1',
        taskType: 'dream',
        status: 'running',
      });
      const localTool = makeTool({
        getTask: vi.fn((id: string) =>
          id === 'dream-running-1' ? dreamRecord : undefined,
        ),
        cancelTask,
      });

      const result = await stop('dream-running-1', localTool);

      expect(cancelTask).toHaveBeenCalledWith('dream-running-1');
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Cancellation requested');
      expect(result.llmContent).toContain('dream task "dream-running-1"');
    });

    it('returns NOT_RUNNING when the dream is already terminal', async () => {
      // Mirrors the agent / shell / monitor not-running guards so a model
      // retry against a finished dream gets the distinct error, not "not found".
      const dreamRecord = memoryTask({
        id: 'dream-done-1',
        taskType: 'dream',
        status: 'completed',
        updatedAt: '2026-05-04T12:01:00.000Z',
      });
      const cancelTask = vi.fn(() => false);
      const localTool = makeTool({
        getTask: vi.fn(() => dreamRecord),
        cancelTask,
      });

      const result = await stop('dream-done-1', localTool);

      expect(cancelTask).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_RUNNING);
      expect(result.llmContent).toContain('Background dream "dream-done-1"');
      expect(result.llmContent).toContain('completed');
    });

    it('cancels a running migration task', async () => {
      const migrationRecord = {
        id: 'migration-running-1',
        taskType: 'migration' as const,
        projectRoot: '/p',
        status: 'running' as const,
        createdAt: '2026-05-04T12:00:00.000Z',
        updatedAt: '2026-05-04T12:00:00.000Z',
      };
      const cancelTask = vi.fn(() => true);
      const localTool = new TaskStopTool({
        getBackgroundTaskRegistry: () => registry,
        abandonBackgroundAgent,
        getBackgroundShellRegistry: () => shellRegistry,
        getMonitorRegistry: () => monitorRegistry,
        getMemoryManager: () => ({
          getTask: vi.fn(() => migrationRecord),
          cancelTask,
        }),
      } as unknown as Config);

      const result = await localTool.validateBuildAndExecute(
        { task_id: migrationRecord.id },
        new AbortController().signal,
      );

      expect(cancelTask).toHaveBeenCalledWith(migrationRecord.id);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('migration task');
      expect(result.llmContent).not.toContain('consolidation lock');
    });

    it('returns NOT_CANCELLABLE when the task id resolves to an extract record', async () => {
      // Extract is short-lived and on the request path; cancelling it would
      // interfere with the user's own turn. "Exists but not cancellable" needs
      // its own error type, or a model retrying an extract id would wrongly
      // conclude the id was never valid.
      const extractRecord = memoryTask({
        id: 'extract-running-1',
        taskType: 'extract',
        status: 'running',
      });
      const cancelTask = vi.fn();
      const localTool = makeTool({
        getTask: vi.fn(() => extractRecord),
        cancelTask,
      });

      const result = await stop('extract-running-1', localTool);

      expect(cancelTask).not.toHaveBeenCalled();
      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_NOT_CANCELLABLE);
      expect(result.llmContent).toContain('extract');
      expect(result.llmContent).toContain('not cancellable');
    });

    it('returns an error when cancelTask returns false (missing AbortController)', async () => {
      // MemoryManager.cancelTask returns false when a running record has no
      // AbortController (an invariant violation). task_stop must surface that,
      // not report a phantom success while the dream keeps burning tokens.
      const dreamRecord = memoryTask({
        id: 'dream-broken-1',
        taskType: 'dream',
        status: 'running',
      });
      const localTool = makeTool({
        getTask: vi.fn(() => dreamRecord),
        cancelTask: vi.fn(() => false),
      });

      const result = await stop('dream-broken-1', localTool);

      expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_INTERNAL_ERROR);
      expect(result.llmContent).toContain('could not be cancelled');
    });
  });
});

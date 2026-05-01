/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskStopTool } from './task-stop.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { BackgroundShellRegistry } from '../services/backgroundShellRegistry.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

describe('TaskStopTool', () => {
  let registry: BackgroundTaskRegistry;
  let shellRegistry: BackgroundShellRegistry;
  let config: Config;
  let tool: TaskStopTool;
  let abandonBackgroundAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    abandonBackgroundAgent = vi.fn();
    shellRegistry = new BackgroundShellRegistry();
    config = {
      getBackgroundTaskRegistry: () => registry,
      abandonBackgroundAgent,
      getBackgroundShellRegistry: () => shellRegistry,
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
});

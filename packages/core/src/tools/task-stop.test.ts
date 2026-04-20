/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStopTool } from './task-stop.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

describe('TaskStopTool', () => {
  let registry: BackgroundTaskRegistry;
  let config: Config;
  let tool: TaskStopTool;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    config = {
      getBackgroundTaskRegistry: () => registry,
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

  it('returns error for non-existent agent', async () => {
    const result = await tool.validateBuildAndExecute(
      { task_id: 'nope' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_AGENT_NOT_FOUND);
    expect(result.llmContent).toContain('No background agent found');
  });

  it('returns error for non-running agent', async () => {
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

    expect(result.error?.type).toBe(ToolErrorType.TASK_STOP_AGENT_NOT_RUNNING);
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
});

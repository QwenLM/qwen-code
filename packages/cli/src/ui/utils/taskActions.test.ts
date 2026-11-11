/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionLifecycleService,
  TaskRegistry,
  type WorkflowUnifiedTask,
  type BashUnifiedTask,
} from '@qwen-code/core';
import { dismissTask } from './taskActions.js';

describe('dismissTask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps a bash task running when termination fails', async () => {
    const registry = new TaskRegistry();
    const task: BashUnifiedTask = {
      id: 'b-test',
      type: 'local_bash',
      status: 'running',
      description: 'test command',
      startTime: Date.now(),
      notified: false,
      executionId: 1234,
      completionBehavior: 'notify',
      command: 'sleep 5',
      isBackgrounded: true,
      output: '',
    };
    registry.register(task);
    vi.spyOn(ExecutionLifecycleService, 'kill').mockRejectedValue(
      new Error('Access is denied'),
    );
    const addInfo = vi.fn();
    dismissTask(registry, task, addInfo);
    await Promise.resolve();
    expect(registry.get(task.id)?.status).toBe('running');
    expect(addInfo).toHaveBeenCalledWith(
      expect.stringContaining('Could not stop task'),
    );
  });

  it('records user_stop before cleaning up a running Workflow execution', () => {
    const registry = new TaskRegistry();
    const abortController = new AbortController();
    const task: WorkflowUnifiedTask = {
      id: 'wf-task',
      type: 'local_workflow',
      status: 'running',
      description: 'Audit repository',
      startTime: Date.now(),
      notified: false,
      executionId: 2_000_000_001,
      completionBehavior: 'notify',
      workflowRunId: 'wf_run',
      workflowName: 'audit',
      scriptPath: '/tmp/audit.js',
      transcriptDir: '/tmp/transcripts',
      progress: [],
      logs: [],
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      abortController,
      agentControllers: {},
    };
    registry.register(task);
    const kill = vi
      .spyOn(ExecutionLifecycleService, 'kill')
      .mockResolvedValue(undefined);

    dismissTask(registry, task);

    expect(abortController.signal.reason).toBe('user_stop');
    expect(registry.get(task.id)).toMatchObject({
      status: 'killed',
      notified: true,
      abortController: undefined,
      agentControllers: undefined,
    });
    expect(kill).toHaveBeenCalledWith(task.executionId, 'user_stop');
  });
});

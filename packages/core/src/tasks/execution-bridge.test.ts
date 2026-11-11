/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  disposeSessionEventQueue,
  drainSubagentSdkEvents,
} from '../agents/subagent-sdk-events.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import {
  _resetQueueForTest,
  getCommandQueueSnapshot,
} from '../services/messageQueueManager.js';
import { bridgeExecutionLifecycleToRegistry } from './execution-bridge.js';
import { stopTask } from './task-control.js';
import { TaskRegistry } from './task-registry.js';

describe('bridgeExecutionLifecycleToRegistry', () => {
  beforeAll(async () => {
    const { initializeShellParsers } = await import('../utils/shell-utils.js');
    await initializeShellParsers();
  });

  beforeEach(() => {
    ExecutionLifecycleService.resetForTest();
    _resetQueueForTest();
    disposeSessionEventQueue('session-1');
  });

  it('only projects executions from the configured session', () => {
    const registry = new TaskRegistry();
    const cleanup = bridgeExecutionLifecycleToRegistry(registry, {
      sessionId: 'session-a',
    });

    const ownExecution = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'child_process',
      undefined,
      'own command',
      'notify',
      { taskId: 'own', sessionId: 'session-a', taskKind: 'bash' },
    );
    const otherExecution = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'child_process',
      undefined,
      'other command',
      'notify',
      { taskId: 'other', sessionId: 'session-b', taskKind: 'bash' },
    );
    if (ownExecution.pid === undefined || otherExecution.pid === undefined) {
      throw new Error('Expected execution IDs.');
    }

    ExecutionLifecycleService.background(ownExecution.pid, 'model');
    ExecutionLifecycleService.background(otherExecution.pid, 'model');

    expect(registry.getByPublicId('own')).toBeDefined();
    expect(registry.getByPublicId('other')).toBeUndefined();

    cleanup();
  });

  it('replaces snapshot output and appends delta output for background shell tasks', async () => {
    const registry = new TaskRegistry();
    const cleanup = bridgeExecutionLifecycleToRegistry(registry);

    const handle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'child_process',
      undefined,
      'echo test',
      'notify',
    );
    if (handle.pid === undefined) {
      throw new Error('Expected execution ID.');
    }

    ExecutionLifecycleService.appendOutput(handle.pid, 'before ');
    ExecutionLifecycleService.background(handle.pid, 'user');
    await handle.result;

    const taskId = `b-${handle.pid}`;
    let task = registry.get(taskId);
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toBe('before ');

    ExecutionLifecycleService.appendOutput(handle.pid, 'after');
    task = registry.get(taskId);
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toBe('before after');

    ExecutionLifecycleService.emitEvent(handle.pid, {
      type: 'data',
      chunk: 'snapshot',
      isSnapshot: true,
    });
    task = registry.get(taskId);
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toBe('snapshot');

    cleanup();
  });

  it('registers the public Bash ID and emits task_started', async () => {
    const registry = new TaskRegistry();
    const cleanup = bridgeExecutionLifecycleToRegistry(registry);
    const handle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'child_process',
      undefined,
      'compile project',
      'notify',
      {
        taskId: 'b12345678',
        sessionId: 'session-1',
        ownerAgentId: 'agent-1',
        taskKind: 'bash',
        toolUseId: 'tool-1',
        outputPath: '/tmp/b12345678.output',
      },
    );
    if (handle.pid === undefined) throw new Error('Expected execution ID.');

    ExecutionLifecycleService.background(handle.pid, 'model');
    await handle.result;

    expect(registry.get('b-b12345678')).toMatchObject({
      publicId: 'b12345678',
      sessionId: 'session-1',
      ownerAgentId: 'agent-1',
      kind: 'bash',
      toolUseId: 'tool-1',
      outputPath: '/tmp/b12345678.output',
    });
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b12345678',
        tool_use_id: 'tool-1',
        description: 'compile project',
        task_type: 'local_bash',
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          expect.objectContaining({
            task_id: 'b12345678',
            task_type: 'local_bash',
          }),
        ],
      }),
    ]);

    cleanup();
  });

  it('projects a stopped background Bash task as killed', async () => {
    const registry = new TaskRegistry();
    const cleanup = bridgeExecutionLifecycleToRegistry(registry, {
      sessionId: 'session-1',
    });
    const handle = ExecutionLifecycleService.createExecution(
      '',
      undefined,
      'child_process',
      undefined,
      'sleep 60',
      'notify',
      {
        taskId: 'b12345678',
        sessionId: 'session-1',
        taskKind: 'bash',
        toolUseId: 'tool-1',
        outputPath: '/tmp/b12345678.output',
      },
    );
    if (handle.pid === undefined) throw new Error('Expected execution ID.');

    ExecutionLifecycleService.background(handle.pid, 'model');
    await handle.result;
    drainSubagentSdkEvents('session-1', () => true);
    _resetQueueForTest();

    await stopTask({
      registry,
      sessionId: 'session-1',
      taskId: 'b12345678',
    });

    expect(registry.get('b-b12345678')).toMatchObject({
      status: 'killed',
      exitCode: 130,
      notified: true,
    });
    expect(drainSubagentSdkEvents('session-1', () => true)).toEqual([
      expect.objectContaining({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'b12345678',
        patch: expect.objectContaining({ status: 'killed' }),
      }),
      expect.objectContaining({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
      }),
    ]);
    expect(getCommandQueueSnapshot()).toContainEqual(
      expect.objectContaining({
        commandMode: 'task-notification',
        prompt: expect.stringContaining('<status>killed</status>'),
      }),
    );

    cleanup();
  });

  it.each([
    {
      shellType: 'powershell' as const,
      exitCode: 143,
      signal: 15,
      expected: 'killed',
    },
    {
      shellType: 'powershell' as const,
      exitCode: 143,
      signal: null,
      expected: 'failed',
    },
    {
      shellType: 'powershell' as const,
      exitCode: 0,
      signal: 15,
      expected: 'killed',
    },
    {
      shellType: 'bash' as const,
      exitCode: 143,
      signal: 15,
      expected: 'failed',
    },
    {
      shellType: 'bash' as const,
      exitCode: 0,
      signal: 15,
      expected: 'completed',
    },
  ])(
    'uses actual signal evidence for terminal status: %j',
    ({ shellType, exitCode, signal, expected }) => {
      const registry = new TaskRegistry();
      const cleanup = bridgeExecutionLifecycleToRegistry(registry);
      try {
        const handle = ExecutionLifecycleService.createExecution(
          '',
          undefined,
          'child_process',
          undefined,
          'test command',
          'silent',
          { taskId: 'signal-task', taskKind: 'bash', shellType },
        );
        expect(handle.pid).toBeDefined();
        ExecutionLifecycleService.background(handle.pid!, 'model');
        ExecutionLifecycleService.completeExecution(handle.pid!, {
          exitCode,
          signal,
        });
        expect(registry.getByPublicId('signal-task')).toMatchObject({
          status: expected,
          exitCode,
        });
      } finally {
        cleanup();
      }
    },
  );
});

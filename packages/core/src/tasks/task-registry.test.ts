/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASH_OUTPUT_TRUNCATION_BUFFER,
  MAX_BASH_OUTPUT_SIZE,
  TaskRegistry,
} from './task-registry.js';
import type { SubagentProgress } from '../agents/types.js';
import type { Message } from '../protocol/transcript/message.js';
import { isAgentTask } from './unified-task.js';
import type {
  AgentUnifiedTask,
  BashUnifiedTask,
  InternalAgentUnifiedTask,
  WorkflowUnifiedTask,
} from './unified-task.js';

function createBashTask(output = ''): BashUnifiedTask {
  return {
    id: 'b-1',
    type: 'local_bash',
    status: 'running',
    description: 'background command',
    startTime: Date.now(),
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    command: 'long command',
    isBackgrounded: true,
    output,
  };
}

function createAgentTask(): AgentUnifiedTask {
  return {
    id: 'a-agent-1',
    type: 'local_agent',
    status: 'running',
    description: 'agent task',
    startTime: Date.now(),
    notified: false,
    executionId: 2,
    completionBehavior: 'notify',
    agentId: 'agent-1',
    agentName: 'Explore',
    agentType: 'Explore',
    prompt: 'Inspect files',
    isBackgrounded: true,
    taskId: 'agent-1',
  };
}

function createWorkflowTask(): WorkflowUnifiedTask {
  return {
    id: 'wf-1',
    type: 'local_workflow',
    status: 'running',
    description: 'workflow task',
    startTime: Date.now(),
    notified: false,
    executionId: 3,
    completionBehavior: 'notify',
    workflowRunId: 'wf_abc123',
    workflowName: 'audit',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/wf',
    progress: [],
    logs: [],
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    agentControllers: {},
  };
}

function createInternalAgentTask(): InternalAgentUnifiedTask {
  return {
    id: 'internal-memory',
    type: 'internal_agent',
    status: 'running',
    description: 'Extracting memories',
    startTime: Date.now(),
    notified: false,
    executionId: -1,
    completionBehavior: 'silent',
    agentName: 'Memory',
    agentType: 'memory',
    prompt: 'Extract memories',
    phase: 'extracting',
    isBackgrounded: true,
    killable: false,
  };
}

function createProgress(content: string): SubagentProgress {
  return {
    isSubagentProgress: true,
    agentName: 'Explore',
    recentActivity: [
      {
        id: content,
        type: 'thought',
        content,
        status: 'running',
      },
    ],
    state: 'running',
  };
}

function createMessage(uuid: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: uuid },
  };
}

describe('TaskRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds bash output when replacing snapshots', () => {
    const registry = new TaskRegistry();
    registry.register(createBashTask());

    const oversized = 'a'.repeat(
      MAX_BASH_OUTPUT_SIZE + BASH_OUTPUT_TRUNCATION_BUFFER + 1,
    );
    registry.updateBashOutput('b-1', oversized, false);

    const task = registry.get('b-1');
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toHaveLength(MAX_BASH_OUTPUT_SIZE);
    expect(task.output).toBe(oversized.slice(-MAX_BASH_OUTPUT_SIZE));
  });

  it('atomically bounds concurrent Agent slots and releases them idempotently', () => {
    const registry = new TaskRegistry();
    const releaseFirst = registry.tryAcquireAgentSlot(2);
    const releaseSecond = registry.tryAcquireAgentSlot(2);

    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseSecond).toBeTypeOf('function');
    expect(registry.getConcurrentAgentSlotCount()).toBe(2);
    expect(registry.tryAcquireAgentSlot(2)).toBeUndefined();

    releaseFirst?.();
    releaseFirst?.();
    expect(registry.getConcurrentAgentSlotCount()).toBe(1);

    const releaseReplacement = registry.tryAcquireAgentSlot(2);
    expect(releaseReplacement).toBeTypeOf('function');
    expect(registry.getConcurrentAgentSlotCount()).toBe(2);

    releaseSecond?.();
    releaseReplacement?.();
    expect(registry.getConcurrentAgentSlotCount()).toBe(0);
  });

  it('clears Agent concurrency reservations with the registry', () => {
    const registry = new TaskRegistry();
    expect(registry.tryAcquireAgentSlot(1)).toBeTypeOf('function');

    registry.clear();

    expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    expect(registry.tryAcquireAgentSlot(1)).toBeTypeOf('function');
  });

  it('waits for an Agent slot and preserves the configured limit', async () => {
    const registry = new TaskRegistry();
    const releaseFirst = registry.tryAcquireAgentSlot(1);
    const waiting = registry.acquireAgentSlot(1);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(registry.getConcurrentAgentSlotCount()).toBe(1);

    releaseFirst?.();
    const releaseSecond = await waiting;
    expect(registry.getConcurrentAgentSlotCount()).toBe(1);
    releaseSecond();
    expect(registry.getConcurrentAgentSlotCount()).toBe(0);
  });

  it('cancels a pending Agent slot waiter without consuming a later slot', async () => {
    const registry = new TaskRegistry();
    const release = registry.tryAcquireAgentSlot(1);
    const controller = new AbortController();
    const waiting = registry.acquireAgentSlot(1, controller.signal);

    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    release?.();

    expect(registry.getConcurrentAgentSlotCount()).toBe(0);
    expect(registry.tryAcquireAgentSlot(1)).toBeTypeOf('function');
  });

  it('rejects pending Agent slot waiters when the registry is cleared', async () => {
    const registry = new TaskRegistry();
    registry.tryAcquireAgentSlot(1);
    const waiting = registry.acquireAgentSlot(1);

    registry.clear();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(registry.getConcurrentAgentSlotCount()).toBe(0);
  });

  it('bounds bash output when appending deltas', () => {
    const registry = new TaskRegistry();
    registry.register(createBashTask('prefix'));

    const oversized = 'b'.repeat(
      MAX_BASH_OUTPUT_SIZE + BASH_OUTPUT_TRUNCATION_BUFFER + 1,
    );
    registry.appendBashOutput('b-1', oversized, false);

    const task = registry.get('b-1');
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toHaveLength(MAX_BASH_OUTPUT_SIZE);
    expect(task.output).toBe(('prefix' + oversized).slice(-MAX_BASH_OUTPUT_SIZE));
  });

  it('bounds bash output when generic updates include output', () => {
    const registry = new TaskRegistry();
    registry.register(createBashTask());

    const oversized = 'c'.repeat(
      MAX_BASH_OUTPUT_SIZE + BASH_OUTPUT_TRUNCATION_BUFFER + 1,
    );
    registry.update('b-1', { output: oversized });

    const task = registry.get('b-1');
    expect(task?.type).toBe('local_bash');
    if (task?.type !== 'local_bash') return;
    expect(task.output).toHaveLength(MAX_BASH_OUTPUT_SIZE);
  });

  it('flushes the latest throttled agent progress update', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const registry = new TaskRegistry();
    registry.register(createAgentTask());
    const updates: AgentUnifiedTask[] = [];
    registry.on('task_updated', (_taskId, task) => {
      if (task.type === 'local_agent') updates.push(task);
    });

    registry.updateProgress('a-agent-1', createProgress('first'));
    expect(updates).toHaveLength(1);
    expect(updates.at(-1)?.progress?.recentActivity[0]?.content).toBe('first');

    vi.setSystemTime(1_050);
    registry.updateProgress('a-agent-1', createProgress('last'));
    expect(updates).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(50);

    expect(updates).toHaveLength(2);
    expect(updates.at(-1)?.progress?.recentActivity[0]?.content).toBe('last');
  });

  it('clears pending agent progress flushes when a task reaches terminal status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const registry = new TaskRegistry();
    registry.register(createAgentTask());
    const updates: AgentUnifiedTask[] = [];
    registry.on('task_updated', (_taskId, task) => {
      if (task.type === 'local_agent') updates.push(task);
    });

    registry.updateProgress('a-agent-1', createProgress('first'));
    vi.setSystemTime(2_050);
    registry.updateProgress('a-agent-1', createProgress('last'));
    registry.update('a-agent-1', { status: 'completed' });

    await vi.advanceTimersByTimeAsync(100);

    expect(updates).toHaveLength(2);
    expect(updates.at(-1)?.status).toBe('completed');
    expect(updates.at(-1)?.progress?.recentActivity[0]?.content).toBe('last');
  });

  it('keeps only the latest race message for an active persisted agent', () => {
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });

    registry.appendMessage('a-agent-1', createMessage('first'), ['tool-1']);
    registry.appendMessage('a-agent-1', createMessage('last'), []);

    const task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['last']);
    expect(task && isAgentTask(task) ? task.inProgressToolUseIds : undefined)
      .toEqual([]);
  });

  it('keeps a viewed suffix and collapses it when the detail view closes', () => {
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });
    registry.appendMessage('a-agent-1', createMessage('before-open'), []);
    registry.update('a-agent-1', { retainReason: 'agent-session-view' });
    registry.appendMessage('a-agent-1', createMessage('while-open-1'), []);
    registry.appendMessage('a-agent-1', createMessage('while-open-2'), []);

    let task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['before-open', 'while-open-1', 'while-open-2']);

    registry.update('a-agent-1', { retainReason: undefined });
    task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['while-open-2']);
  });

  it('replaces the race message without retaining duplicate persisted events', () => {
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });

    registry.appendMessage('a-agent-1', createMessage('first'), []);
    registry.appendMessage('a-agent-1', createMessage('second'), []);
    registry.appendMessage('a-agent-1', createMessage('first'), []);

    const task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['first']);
  });

  it('retains a live suffix only while an inline transcript viewer is mounted', () => {
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });

    registry.appendMessage('a-agent-1', createMessage('before-open'), []);
    const release = registry.acquireTranscriptViewer('a-agent-1');
    registry.appendMessage('a-agent-1', createMessage('while-open-1'), []);
    registry.appendMessage('a-agent-1', createMessage('while-open-2'), []);

    let task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['before-open', 'while-open-1', 'while-open-2']);

    release();
    release();
    task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['while-open-2']);
  });

  it('counts transcript viewers independently by agent task id', () => {
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });
    registry.register({
      ...createAgentTask(),
      id: 'a-agent-2',
      agentId: 'agent-2',
      taskId: 'agent-2',
      outputPath: '/tmp/agent-2.jsonl',
    });

    const releaseFirstA = registry.acquireTranscriptViewer('a-agent-1');
    const releaseSecondA = registry.acquireTranscriptViewer('a-agent-1');
    const releaseB = registry.acquireTranscriptViewer('a-agent-2');
    registry.appendMessage('a-agent-1', createMessage('a-1'), []);
    registry.appendMessage('a-agent-1', createMessage('a-2'), []);
    registry.appendMessage('a-agent-2', createMessage('b-1'), []);
    registry.appendMessage('a-agent-2', createMessage('b-2'), []);

    releaseFirstA();
    releaseB();

    let first = registry.get('a-agent-1');
    let second = registry.get('a-agent-2');
    expect(first && isAgentTask(first) ? first.liveMessages : undefined)
      .toHaveLength(2);
    expect(second && isAgentTask(second) ? second.liveMessages : undefined)
      .toHaveLength(1);

    releaseSecondA();
    first = registry.get('a-agent-1');
    second = registry.get('a-agent-2');
    expect(first && isAgentTask(first) ? first.liveMessages : undefined)
      .toHaveLength(1);
    expect(second && isAgentTask(second) ? second.liveMessages : undefined)
      .toHaveLength(1);
  });

  it('does not evict a terminal agent while an inline transcript viewer is mounted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const registry = new TaskRegistry();
    registry.register({
      ...createAgentTask(),
      outputPath: '/tmp/agent-1.jsonl',
    });
    const release = registry.acquireTranscriptViewer('a-agent-1');
    registry.update('a-agent-1', {
      status: 'completed',
      notified: true,
    });

    vi.setSystemTime(34_000);
    expect(registry.evictTerminal('a-agent-1')).toBe(false);

    release();
    expect(registry.evictTerminal('a-agent-1')).toBe(true);
  });

  it('keeps in-memory history when no persisted transcript is available', () => {
    const registry = new TaskRegistry();
    registry.register(createAgentTask());

    registry.appendMessage('a-agent-1', createMessage('first'), []);
    registry.appendMessage('a-agent-1', createMessage('second'), []);

    const task = registry.get('a-agent-1');
    expect(
      task && isAgentTask(task)
        ? task.liveMessages?.map((message) => message.uuid)
        : undefined,
    ).toEqual(['first', 'second']);
  });

  it('keeps terminal tasks while they are retained by a detail view', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);

    const registry = new TaskRegistry();
    registry.register(createBashTask());
    registry.register(createAgentTask());
    registry.update('b-1', {
      status: 'completed',
      notified: true,
      retainReason: 'task-detail-view',
    });
    registry.update('a-agent-1', {
      status: 'completed',
      notified: true,
      retainReason: 'task-detail-view',
    });

    vi.setSystemTime(34_000);
    registry.evictAllTerminal();

    expect(registry.get('b-1')).toBeDefined();
    expect(registry.get('a-agent-1')).toBeDefined();

    registry.update('b-1', { retainReason: undefined });
    registry.update('a-agent-1', { retainReason: undefined });
    registry.evictAllTerminal();

    expect(registry.get('b-1')).toBeUndefined();
    expect(registry.get('a-agent-1')).toBeUndefined();
  });

  it('evicts notified terminal workflows after the grace period', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);

    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());
    registry.update('wf-1', {
      status: 'completed',
      notified: true,
    });

    vi.setSystemTime(34_000);
    registry.evictAllTerminal();

    expect(registry.get('wf-1')).toBeUndefined();
  });

  it('keeps an expired terminal workflow while its detail is viewed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);

    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());
    registry.update('wf-1', {
      status: 'completed',
      notified: true,
      retainReason: 'task-detail-view',
    });

    vi.setSystemTime(34_000);
    expect(registry.evictTerminal('wf-1')).toBe(false);
    expect(registry.get('wf-1')).toBeDefined();

    registry.update('wf-1', { retainReason: undefined });

    expect(registry.evictTerminal('wf-1')).toBe(true);
    expect(registry.get('wf-1')).toBeUndefined();
  });

  it('merges workflow progress and trims logs', () => {
    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());

    registry.updateWorkflowProgress('wf-1', [
      { type: 'workflow_phase', index: 1, title: 'Read' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'Reader',
        state: 'start',
        promptPreview: 'Read the repository',
      },
      { type: 'workflow_log', message: 'first', timestamp: 1 },
    ]);
    registry.updateWorkflowProgress('wf-1', [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'Reader',
        state: 'done',
        resultPreview: 'ok',
        tokens: 12,
        toolCalls: 2,
      },
      { type: 'workflow_log', message: 'second', timestamp: 2 },
    ]);
    registry.updateWorkflowProgress('wf-1', [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'Reader',
        state: 'done',
        resultPreview: 'ok',
        tokens: 15,
        toolCalls: 3,
      },
    ]);
    registry.updateWorkflowProgress('wf-1', [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'Reader',
        state: 'done',
        promptPreview: undefined,
        resultPreview: undefined,
        tokens: 18,
      },
    ]);

    const task = registry.get('wf-1');
    expect(task?.type).toBe('local_workflow');
    if (task?.type !== 'local_workflow') return;
    expect(task.progress).toHaveLength(4);
    expect(task.logs).toEqual(['first', 'second']);
    expect(
      task.progress.find(
        (item) => item.type === 'workflow_agent' && item.index === 1,
      ),
    ).toMatchObject({
      state: 'done',
      promptPreview: 'Read the repository',
      resultPreview: 'ok',
      tokens: 18,
      toolCalls: 3,
    });
    expect(task.agentCount).toBe(1);
    expect(task.totalTokens).toBe(18);
    expect(task.totalToolCalls).toBe(3);
  });

  it('tracks workflow agent controllers independently', () => {
    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());
    const first = new AbortController();
    const second = new AbortController();

    registry.setWorkflowAgentController('wf-1', '1', first);
    registry.setWorkflowAgentController('wf-1', '2', second);
    registry.setWorkflowAgentController('wf-1', '1', undefined);

    const task = registry.get('wf-1');
    expect(task?.type).toBe('local_workflow');
    if (task?.type !== 'local_workflow') return;
    expect(task.agentControllers).toEqual({ '2': second });
  });

  it('aborts workflow agent controllers with skip and retry reasons', () => {
    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());
    const skipController = new AbortController();
    const retryController = new AbortController();

    registry.setWorkflowAgentController('wf-1', '1', skipController);
    registry.setWorkflowAgentController('wf-1', '2', retryController);

    expect(registry.skipWorkflowAgent('wf-1', '1')).toBe(true);
    expect(registry.retryWorkflowAgent('wf-1', '2')).toBe(true);
    expect(skipController.signal.aborted).toBe(true);
    expect(skipController.signal.reason).toBe('user-skip');
    expect(retryController.signal.aborted).toBe(true);
    expect(retryController.signal.reason).toBe('user-retry');
    expect(registry.skipWorkflowAgent('wf-1', 'missing')).toBe(false);
  });

  it('claims a workflow killed before aborting its controllers', () => {
    const registry = new TaskRegistry();
    const workflow = createWorkflowTask();
    const topController = workflow.abortController;
    const agentController = new AbortController();
    workflow.agentControllers = { '1': agentController };
    registry.register(workflow);
    const updates = vi.fn();
    registry.on('task_updated', updates);

    let taskObservedDuringAbort: WorkflowUnifiedTask | undefined;
    topController?.signal.addEventListener('abort', () => {
      const current = registry.get('wf-1');
      if (current?.type === 'local_workflow') {
        taskObservedDuringAbort = current;
      }
    });

    registry.kill('wf-1', 'user_stop');
    registry.kill('wf-1', 'session_shutdown');

    expect(taskObservedDuringAbort).toMatchObject({
      status: 'killed',
      abortController: undefined,
      agentControllers: undefined,
    });
    expect(topController?.signal.reason).toBe('user_stop');
    expect(agentController.signal.reason).toBe('user_stop');
    expect(registry.get('wf-1')).toMatchObject({
      status: 'killed',
      endTime: expect.any(Number),
      notified: false,
      abortController: undefined,
      agentControllers: undefined,
    });
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('pauses a live workflow by aborting it and transitioning task state', () => {
    const registry = new TaskRegistry();
    const workflow = createWorkflowTask();
    const abortController = workflow.abortController;
    registry.register(workflow);

    expect(registry.pauseWorkflow('wf-1')).toBe(true);
    const task = registry.get('wf-1');
    expect(task?.type).toBe('local_workflow');
    if (task?.type !== 'local_workflow') return;
    expect(abortController?.signal.aborted).toBe(true);
    expect(abortController?.signal.reason).toBe('workflow-pause');
    expect(task).toMatchObject({
      status: 'paused',
      notified: true,
    });
    expect(task.endTime).toEqual(expect.any(Number));
    expect(task.abortController).toBeUndefined();
    expect(task.agentControllers).toBeUndefined();
    expect(registry.runningCount()).toBe(0);
    registry.updateWorkflowProgress('wf-1', [
      { type: 'workflow_log', message: 'late progress', timestamp: Date.now() },
    ]);
    expect(task.logs).toEqual([]);
    expect(registry.retryWorkflowAgent('wf-1', '1')).toBe(false);
    expect(registry.pauseWorkflow('wf-1')).toBe(false);
  });

  it('does not report pause success without an abort controller', () => {
    const registry = new TaskRegistry();
    const workflow = createWorkflowTask();
    workflow.abortController = undefined;
    registry.register(workflow);

    expect(registry.pauseWorkflow('wf-1')).toBe(false);

    const task = registry.get('wf-1');
    expect(task?.type).toBe('local_workflow');
    if (task?.type !== 'local_workflow') return;
    expect(task.status).toBe('running');
  });

  it('does not pause terminal or non-workflow tasks', () => {
    const registry = new TaskRegistry();
    registry.register(createWorkflowTask());
    registry.register(createAgentTask());
    registry.update('wf-1', { status: 'completed' });

    expect(registry.pauseWorkflow('wf-1')).toBe(false);
    expect(registry.pauseWorkflow('a-agent-1')).toBe(false);
    expect(registry.pauseWorkflow('missing')).toBe(false);
  });

  it('tracks internal agents but does not kill background services', () => {
    const registry = new TaskRegistry();
    registry.register(createInternalAgentTask());

    expect(registry.runningCount()).toBe(1);

    registry.kill('internal-memory');

    const task = registry.get('internal-memory');
    expect(task?.status).toBe('running');
  });
});

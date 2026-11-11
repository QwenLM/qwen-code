/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentUnifiedTask,
  BashUnifiedTask,
  InternalAgentUnifiedTask,
  UnifiedTask,
  WorkflowUnifiedTask,
} from '@qwen-code/core';
import {
  buildBackgroundTaskStatusItems,
  getBackgroundTaskStatusCount,
} from './backgroundTaskStatus.js';

function bashTask(
  id: string,
  command: string,
  overrides: Partial<BashUnifiedTask> = {},
): BashUnifiedTask {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: command,
    startTime: Date.now(),
    notified: false,
    executionId: Number(id.replace(/\D/g, '')) || 1,
    completionBehavior: 'notify',
    command,
    isBackgrounded: true,
    output: '',
    ...overrides,
  };
}

function agentTask(overrides: Partial<AgentUnifiedTask> = {}): AgentUnifiedTask {
  return {
    id: 'a-review',
    type: 'local_agent',
    status: 'running',
    description: 'Review auth changes',
    startTime: Date.now(),
    notified: false,
    executionId: 20,
    completionBehavior: 'notify',
    agentId: 'review',
    agentName: 'reviewer',
    agentType: 'reviewer',
    prompt: 'review',
    isBackgrounded: true,
    taskId: 'task-review',
    ...overrides,
  };
}

function workflowTask(
  overrides: Partial<WorkflowUnifiedTask> = {},
): WorkflowUnifiedTask {
  return {
    id: 'wf-audit',
    type: 'local_workflow',
    status: 'running',
    description: 'Run audit workflow',
    startTime: Date.now(),
    notified: false,
    executionId: 30,
    completionBehavior: 'notify',
    workflowRunId: 'wf-audit',
    workflowName: 'audit',
    title: 'Audit workflow',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/workflows/wf-audit/transcripts',
    progress: [],
    logs: [],
    agentCount: 2,
    totalTokens: 0,
    totalToolCalls: 3,
    abortController: new AbortController(),
    agentControllers: {},
    ...overrides,
  };
}

function internalAgentTask(
  overrides: Partial<InternalAgentUnifiedTask> = {},
): InternalAgentUnifiedTask {
  return {
    id: 'internal-auto-memory',
    type: 'internal_agent',
    status: 'running',
    description: 'Memory',
    startTime: Date.now(),
    notified: false,
    executionId: -1,
    completionBehavior: 'silent',
    agentName: 'Memory',
    agentType: 'memory',
    prompt: 'Memory',
    phase: 'running',
    isBackgrounded: true,
    killable: false,
    ...overrides,
  };
}

describe('background task status projection', () => {
  it('returns no items when no live background work exists', () => {
    expect(buildBackgroundTaskStatusItems({})).toEqual([]);
    expect(getBackgroundTaskStatusCount({})).toBe(0);
  });

  it('projects registry tasks', () => {
    const items = buildBackgroundTaskStatusItems({
      tasks: [bashTask('b-1', 'npm test -- --runInBand')],
    });

    expect(items).toMatchObject([
      {
        kind: 'Bash',
        title: 'npm test -- --runInBand',
      },
    ]);
  });

  it('filters terminal tasks and foreground agents', () => {
    const tasks: UnifiedTask[] = [
      bashTask('b-1', 'sleep 10'),
      bashTask('b-2', 'already done', { status: 'completed' }),
      agentTask({ isBackgrounded: false }),
      workflowTask({ status: 'paused', endTime: Date.now() }),
    ];

    const items = buildBackgroundTaskStatusItems({ tasks });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'Bash',
      title: 'sleep 10',
    });
  });

  it('projects workflow and subagent details for status consumers', () => {
    const items = buildBackgroundTaskStatusItems({
      tasks: [agentTask(), workflowTask()],
    });

    expect(items).toMatchObject([
      { kind: 'Subagent', detail: 'reviewer' },
      { kind: 'Workflow', detail: '2 agents, 3 tools' },
    ]);
  });

  it('combines registry internal memory and dream agents', () => {
    const tasks: UnifiedTask[] = [
      internalAgentTask(),
      internalAgentTask({
        id: 'internal-auto-dream',
        executionId: -2,
        description: 'Dreaming',
        agentName: 'Dreaming',
        agentType: 'dream',
        phase: 'running',
      }),
    ];

    const items = buildBackgroundTaskStatusItems({ tasks });

    expect(items).toHaveLength(1);
    expect(items).toMatchObject([
      {
        kind: 'Memory',
        title: 'Memory · Dreaming',
      },
    ]);
  });

  it('excludes tasks represented by the agent session rail after memory and dream projection', () => {
    const tasks: UnifiedTask[] = [
      bashTask('b-1', 'sleep 10'),
      internalAgentTask(),
      internalAgentTask({
        id: 'internal-auto-dream',
        executionId: -2,
        description: 'Dreaming',
        agentName: 'Dreaming',
        agentType: 'dream',
      }),
    ];

    expect(
      getBackgroundTaskStatusCount({
        tasks,
        excludeAgentSessionRailTasks: true,
      }),
    ).toBe(1);
  });
});

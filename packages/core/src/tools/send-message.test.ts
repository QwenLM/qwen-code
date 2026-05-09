/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SendMessageTool } from './send-message.js';
import { TaskRegistry } from '../tasks/registry.js';
import {
  agentCancel,
  agentComplete,
  agentRegister,
  getAgentTask,
} from '../tasks/agent-task.js';
import type { Config } from '../config/config.js';
import { ToolErrorType } from './tool-error.js';

describe('SendMessageTool', () => {
  let registry: TaskRegistry;
  let config: Config;
  let tool: SendMessageTool;
  let resumeBackgroundAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new TaskRegistry();
    resumeBackgroundAgent = vi.fn();
    config = {
      getTaskRegistry: () => registry,
      resumeBackgroundAgent,
    } as unknown as Config;
    tool = new SendMessageTool(config);
  });

  it('queues a message for a running task', async () => {
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'do more work' },
      new AbortController().signal,
    );

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Message queued');
    expect(getAgentTask(registry, 'agent-1')!.pendingMessages).toEqual([
      'do more work',
    ]);
  });

  it('queues multiple messages in order', async () => {
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'first' },
      new AbortController().signal,
    );
    await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'second' },
      new AbortController().signal,
    );

    expect(getAgentTask(registry, 'agent-1')!.pendingMessages).toEqual([
      'first',
      'second',
    ]);
  });

  it('returns error for non-existent task', async () => {
    const result = await tool.validateBuildAndExecute(
      { task_id: 'nope', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
  });

  it('returns error for non-running task', async () => {
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    agentComplete(registry, 'agent-1', 'done');

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('not running');
  });

  it('rejects messages for a cancelled task', async () => {
    // Once task_stop fires, the reasoning loop is winding down — there is
    // no next tool-round boundary to drain into, so the message would be
    // silently dropped. Reject instead of accepting a message that will
    // never be delivered.
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    agentCancel(registry, 'agent-1');

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'too late' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(getAgentTask(registry, 'agent-1')!.pendingMessages).toEqual([]);
  });

  it('resumes a paused task and injects the message as continuation input', async () => {
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'test agent',
      status: 'paused',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    resumeBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'pick up from the TODO list' },
      new AbortController().signal,
    );

    expect(resumeBackgroundAgent).toHaveBeenCalledWith(
      'agent-1',
      'pick up from the TODO list',
    );
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('resumed');
  });

  it('includes task description in success display', async () => {
    agentRegister(registry, {
      agentId: 'agent-1',
      description: 'Search for auth code',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'focus on login' },
      new AbortController().signal,
    );

    expect(result.returnDisplay).toContain('Search for auth code');
  });
});

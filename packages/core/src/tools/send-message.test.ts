/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendMessageTool } from './send-message.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { ToolErrorType } from './tool-error.js';
import type { ApprovalMode, Config } from '../config/config.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';

const DEFAULT_MODE = 'default' as ApprovalMode;
const PLAN_MODE = 'plan' as ApprovalMode;

function makeTeamConfig(opts?: {
  teamManager?: {
    sendMessage: (...args: unknown[]) => Promise<void>;
    broadcast: (...args: unknown[]) => Promise<void>;
    requestShutdown?: (...args: unknown[]) => Promise<void>;
  } | null;
  approvalMode?: ApprovalMode;
}) {
  return {
    getTeamManager: () => opts?.teamManager ?? null,
    getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
    getApprovalMode: () => opts?.approvalMode ?? DEFAULT_MODE,
  } as unknown as Config;
}

describe('SendMessageTool — team mode', () => {
  it('has the correct name', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    expect(tool.name).toBe('send_message');
  });

  it('sends a message via TeamManager', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage,
          broadcast: vi.fn(),
        },
      }),
    );

    const invocation = tool.build({
      to: 'alice',
      message: 'hello',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('alice');
    expect(sendMessage).toHaveBeenCalledWith(
      'alice',
      'hello',
      'leader',
      undefined,
    );
  });

  it('broadcasts with "*"', async () => {
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi.fn(),
          broadcast,
        },
      }),
    );

    const invocation = tool.build({
      to: '*',
      message: 'hey all',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('broadcast');
    expect(broadcast).toHaveBeenCalledWith('hey all', 'leader');
  });

  it('returns error when no team is active and no task_id given', async () => {
    const tool = new SendMessageTool(makeTeamConfig());
    const invocation = tool.build({
      to: 'alice',
      message: 'hello',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  it('routes shutdown_request via requestShutdown', async () => {
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi.fn(),
          broadcast: vi.fn(),
          requestShutdown,
        },
      }),
    );

    const invocation = tool.build({
      to: 'bob',
      message: 'Please shut down.',
      type: 'shutdown_request',
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Shutdown');
    expect(result.llmContent).toContain('bob');
    expect(requestShutdown).toHaveBeenCalledWith('bob');
  });

  it('rejects shutdown_request from a teammate (leader-only)', async () => {
    // A teammate calling shutdown_request would impersonate the
    // leader, since requestShutdown writes the mailbox entry with
    // `from: LEADER_NAME` and arms shutdown_approved tracking.
    const requestShutdown = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi.fn(),
          broadcast: vi.fn(),
          requestShutdown,
        },
      }),
    );

    const invocation = tool.build({
      to: 'bob',
      message: 'Please shut down.',
      type: 'shutdown_request',
    });
    const result = await runWithTeammateIdentity(
      {
        agentName: 'attacker',
        teamName: 'team',
        agentId: 'attacker@team',
        isTeamLead: false,
      },
      () => invocation.execute(new AbortController().signal),
    );
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('Only the team leader');
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it('blocks plan-required teammates before leader approval', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        approvalMode: PLAN_MODE,
        teamManager: {
          sendMessage,
          broadcast: vi.fn(),
        },
      }),
    );

    const invocation = tool.build({
      to: 'alice',
      message: 'execute this before approval',
    });
    const result = await runWithTeammateIdentity(
      {
        agentName: 'planner',
        teamName: 'team',
        agentId: 'planner@team',
        isTeamLead: false,
        planModeRequired: true,
      },
      () => invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('waiting for leader approval');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('validates required params', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    // `message` is required.
    expect(() => tool.build({} as never)).toThrow();
    expect(() => tool.build({ to: 'alice' } as never)).toThrow();
  });
});

describe('SendMessageTool — background-task mode', () => {
  let registry: BackgroundTaskRegistry;
  let config: Config;
  let tool: SendMessageTool;
  let resumeBackgroundAgent: ReturnType<typeof vi.fn>;
  let reviveCompletedBackgroundAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    resumeBackgroundAgent = vi.fn();
    reviveCompletedBackgroundAgent = vi.fn();
    config = {
      getBackgroundTaskRegistry: () => registry,
      getTeamManager: () => null,
      resumeBackgroundAgent,
      reviveCompletedBackgroundAgent,
    } as unknown as Config;
    tool = new SendMessageTool(config);
  });

  it('queues a message for a running task', async () => {
    registry.register({
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
    expect(registry.get('agent-1')!.pendingMessages).toEqual(['do more work']);
  });

  it('queues multiple messages in order', async () => {
    registry.register({
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

    expect(registry.get('agent-1')!.pendingMessages).toEqual([
      'first',
      'second',
    ]);
  });

  it('revives a task when it finishes while a message waits at the finalization boundary', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.beginFinishing('agent-1');
    reviveCompletedBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const resultPromise = tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'late correction' },
      new AbortController().signal,
    );
    await Promise.resolve();

    expect(registry.get('agent-1')!.pendingMessages).toEqual([]);
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();

    registry.complete('agent-1', 'done');
    const result = await resultPromise;

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('revived it with your message');
    expect(reviveCompletedBackgroundAgent).toHaveBeenCalledWith(
      'agent-1',
      'late correction',
    );
  });

  it('returns error for non-existent task', async () => {
    const result = await tool.validateBuildAndExecute(
      { task_id: 'nope', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
  });

  it('returns error for a failed (non-running, non-revivable) task', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.fail('agent-1', 'boom');

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('not running');
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
  });

  it('rejects messages for a cancelled task', async () => {
    // Once task_stop fires, the reasoning loop is winding down — there is
    // no next tool-round boundary to drain into, so the message would be
    // silently dropped. Reject instead of accepting a message that will
    // never be delivered.
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    registry.cancel('agent-1');

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'too late' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(registry.get('agent-1')!.pendingMessages).toEqual([]);
  });

  it('resumes a paused task and injects the message as continuation input', async () => {
    registry.register({
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

  it('continues a completed task on its resident runtime', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'completed',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
      metaPath: '/tmp/test.meta.json',
    });
    const continueResident = vi.fn().mockReturnValue(true);
    registry.registerResidentAgent('agent-1', {
      continue: continueResident,
      dispose: vi.fn(),
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'now refactor the helper' },
      new AbortController().signal,
    );

    expect(continueResident).toHaveBeenCalledWith('now refactor the helper');
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
    expect(resumeBackgroundAgent).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('existing runtime');
    expect(result.returnDisplay).toContain('Continued');
  });

  it('revives a completed task when no resident runtime is available', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'completed',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
      metaPath: '/tmp/test.meta.json',
    });
    reviveCompletedBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'now refactor the helper' },
      new AbortController().signal,
    );

    expect(reviveCompletedBackgroundAgent).toHaveBeenCalledWith(
      'agent-1',
      'now refactor the helper',
    );
    expect(resumeBackgroundAgent).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('revived');
    expect(result.returnDisplay).toContain('Revived');
  });

  it('returns error when a completed task cannot be revived', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'completed',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
      metaPath: '/tmp/test.meta.json',
    });
    reviveCompletedBackgroundAgent.mockResolvedValue(undefined);

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'try again' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('could not be revived');
  });

  it('includes task description in success display', async () => {
    registry.register({
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

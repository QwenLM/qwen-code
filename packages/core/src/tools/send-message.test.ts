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
import type { BroadcastResult } from '../agents/team/TeamManager.js';

const sendToPeer = vi.fn();
vi.mock('../ipc/peer-send.js', () => ({
  sendToPeer: (...args: unknown[]) => sendToPeer(...args),
}));

// Default for every test that is not about peer routing: cross-session
// messaging is off, so the tool behaves exactly as it did before it existed.
beforeEach(() => {
  sendToPeer.mockReset();
  sendToPeer.mockResolvedValue({ kind: 'disabled' });
});

const DEFAULT_MODE = 'default' as ApprovalMode;
const PLAN_MODE = 'plan' as ApprovalMode;

function makeTeamConfig(opts?: {
  registry?: BackgroundTaskRegistry;
  teamManager?: {
    sendMessage: (...args: unknown[]) => Promise<void>;
    broadcast: (...args: unknown[]) => Promise<BroadcastResult>;
    getTeamFile?: () => { members: Array<{ name: string }> };
  } | null;
  approvalMode?: ApprovalMode;
}) {
  const teamManager = opts?.teamManager
    ? {
        getTeamFile: () => ({ members: [{ name: 'alice' }, { name: 'bob' }] }),
        ...opts.teamManager,
      }
    : null;
  return {
    getTeamManager: () => teamManager,
    getBackgroundTaskRegistry: () =>
      opts?.registry ?? new BackgroundTaskRegistry(),
    getApprovalMode: () => opts?.approvalMode ?? DEFAULT_MODE,
  } as unknown as Config;
}

describe('SendMessageTool — team mode', () => {
  it('has the correct name', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    expect(tool.name).toBe('send_message');
  });

  it('describes text invisibility as peer-only for teammates', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    expect(tool.description).toContain(
      'Your text output is NOT visible to teammates or to other sessions',
    );
    expect(tool.description).not.toContain('NOT visible to other agents');
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
    const broadcast = vi
      .fn()
      .mockResolvedValue({ total: 2, failedRecipients: [] });
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

  // #9276: the tool used to carry an optional single-value enum
  // `type: ['shutdown_request']` described as "structured message type for
  // control flow". Models filled it while writing an ordinary report, the
  // call was rejected leader-only, and the report content was discarded.
  // The fix is that the field no longer exists — assert the *absence*, since
  // a reworded description would still leave the state representable.
  it('exposes no control discriminator on the schema', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    const schema = tool.schema.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).not.toContain('type');
    expect(JSON.stringify(schema)).not.toContain('shutdown_request');
  });

  it('rejects an empty message at build time', () => {
    const tool = new SendMessageTool(makeTeamConfig());
    expect(() => tool.build({ to: 'alice', message: '' })).toThrow(/message/i);
  });

  it("delivers a teammate's ordinary message to the leader", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: { sendMessage, broadcast: vi.fn() },
      }),
    );

    const invocation = tool.build({
      to: 'leader',
      message: 'Task completed and verified',
    });
    const result = await runWithTeammateIdentity(
      {
        agentName: 'worker',
        teamName: 'team',
        agentId: 'worker@team',
        isTeamLead: false,
      },
      () => invocation.execute(new AbortController().signal),
    );

    expect(result.error).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      'leader',
      'Task completed and verified',
      'worker',
      undefined,
    );
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

  it('rejects ambiguous teammate and background-task destinations', async () => {
    const registry = new BackgroundTaskRegistry();
    registry.register({
      agentId: 'agent-1',
      description: 'test agent',
      status: 'running',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({
        registry,
        teamManager: { sendMessage, broadcast: vi.fn() },
      }),
    );

    const result = await tool.validateBuildAndExecute(
      {
        to: 'alice',
        task_id: 'agent-1',
        message: 'ambiguous destination',
      },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.llmContent).toContain('Only one of "to" or "task_id"');
    expect(registry.get('agent-1')!.pendingMessages).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
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
      getTeamManager: () =>
        ({
          getTeamFile: () => ({ members: [{ name: 'qa-reviewer' }] }),
        }) as ReturnType<Config['getTeamManager']>,
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
    expect(result.llmContent).not.toContain('use `to:');
  });

  it('returns error for non-existent task without an active team', async () => {
    const noTeamTool = new SendMessageTool(
      makeTeamConfig({ registry, teamManager: null }),
    );
    const result = await noTeamTool.validateBuildAndExecute(
      { task_id: 'nope', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
    expect(result.llmContent).not.toContain('use `to:');
  });

  it('suggests the teammate destination for a matching task ID', async () => {
    const result = await tool.validateBuildAndExecute(
      { task_id: 'QA Reviewer', message: 'hello' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('use `to: "qa-reviewer"`');
    expect(result.returnDisplay).toContain(
      'use "to" for teammate "qa-reviewer"',
    );
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

  it('reports the retained-state reason without attempting continuation', async () => {
    registry.register({
      agentId: 'agent-1',
      description: 'unsafe restored agent',
      status: 'completed',
      startTime: Date.now(),
      abortController: new AbortController(),
      isBackgrounded: true,
      outputFile: '/tmp/test.jsonl',
      metaPath: '/tmp/test.meta.json',
      resumeBlockedReason: 'Background task transcript is missing.',
    });

    const result = await tool.validateBuildAndExecute(
      { task_id: 'agent-1', message: 'try again' },
      new AbortController().signal,
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain(
      'Background task transcript is missing.',
    );
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
    expect(resumeBackgroundAgent).not.toHaveBeenCalled();
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

describe('SendMessageTool — peer mode', () => {
  function toolWithoutTeam() {
    return new SendMessageTool(makeTeamConfig());
  }

  it('routes an unknown name to a peer session', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'sent',
      address: 'docs-cd',
      peer: { cwd: '/w/docs' },
    });

    const result = await toolWithoutTeam()
      .build({ to: 'docs-cd', message: 'check the tests', summary: 'ping' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('docs-cd');
    expect(result.llmContent).toContain('/w/docs');
    // The model is told the message may not be acted on immediately, and
    // that it carries no authority over there.
    expect(result.llmContent).toContain('held');
    expect(result.llmContent).toContain("none of your user's authority");
    expect(sendToPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'docs-cd',
        message: 'check the tests',
        approvalMode: DEFAULT_MODE,
      }),
    );
  });

  it('asserts nothing about its mode when the mode is unreadable', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'sent',
      address: 'docs-cd',
      peer: { cwd: '/w/docs' },
    });
    const tool = new SendMessageTool({
      getTeamManager: () => null,
      getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
      getApprovalMode: () => {
        throw new Error('not yet');
      },
    } as unknown as Config);

    await tool
      .build({ to: 'docs-cd', message: 'hi' })
      .execute(new AbortController().signal);

    expect(sendToPeer).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: null }),
    );
  });

  it('prefers a teammate over a same-named peer session', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({ teamManager: { sendMessage, broadcast: vi.fn() } }),
    );

    await tool
      .build({ to: 'alice', message: 'hello' })
      .execute(new AbortController().signal);

    expect(sendMessage).toHaveBeenCalled();
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('recognises a teammate by its sanitized name, not the raw string', async () => {
    // TeamManager.sendMessage resolves through findMemberByName, which
    // sanitizes; the precedence check must use the same rule or "Alice"
    // would go looking for a session.
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const tool = new SendMessageTool(
      makeTeamConfig({ teamManager: { sendMessage, broadcast: vi.fn() } }),
    );
    await tool
      .build({ to: 'Alice', message: 'hello' })
      .execute(new AbortController().signal);
    expect(sendMessage).toHaveBeenCalled();
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('reaches a peer even while a team is active, when no teammate has that name', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    sendToPeer.mockResolvedValue({
      kind: 'sent',
      address: 'docs-cd',
      peer: { cwd: '/w/docs' },
    });
    const tool = new SendMessageTool(
      makeTeamConfig({ teamManager: { sendMessage, broadcast: vi.fn() } }),
    );

    const result = await tool
      .build({ to: 'docs-cd', message: 'hello' })
      .execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(sendToPeer).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('never broadcasts across sessions', async () => {
    const result = await toolWithoutTeam()
      .build({ to: '*', message: 'hey all' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not supported');
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('tells the model when it addressed itself', async () => {
    sendToPeer.mockResolvedValue({ kind: 'self', name: 'app-ab' });

    const result = await toolWithoutTeam()
      .build({ to: 'app-ab', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain("this session's own name");
  });

  it('surfaces an ambiguous name with the candidates', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'ambiguous',
      matches: ['app-ab [aaa111] in /w/one', 'app-ab [bbb222] in /w/two'],
    });

    const result = await toolWithoutTeam()
      .build({ to: 'app-ab', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('aaa111');
    expect(result.llmContent).toContain('name [ref]');
  });

  it('suggests near-misses for an unknown name', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'not-found',
      suggestions: ['qwen-code-f7'],
    });

    const result = await toolWithoutTeam()
      .build({ to: 'qwen-code', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('qwen-code-f7');
  });

  it('falls through to the team error when nothing resembles the name', async () => {
    sendToPeer.mockResolvedValue({ kind: 'not-found', suggestions: [] });

    const result = await toolWithoutTeam()
      .build({ to: 'zzz', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
    expect(result.llmContent).toContain('"zzz"');
  });

  it('reports a delivery failure against the address it tried', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'failed',
      address: 'docs-cd',
      peer: { cwd: '/w/docs' },
      reason: 'that session just exited',
    });

    const result = await toolWithoutTeam()
      .build({ to: 'docs-cd', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('docs-cd');
    expect(result.llmContent).toContain('just exited');
  });

  it('falls through to the team error when messaging is off', async () => {
    sendToPeer.mockResolvedValue({ kind: 'disabled' });

    const result = await toolWithoutTeam()
      .build({ to: 'docs-cd', message: 'hi' })
      .execute(new AbortController().signal);

    expect(result.llmContent).toContain('No active team');
  });

  it("never routes a teammate's report to the leader through the peer directory", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    // A session named "leaderboard-3c" is reachable: the peer route would
    // suggest it for "leader" and swallow the report.
    sendToPeer.mockResolvedValue({
      kind: 'not-found',
      suggestions: ['leaderboard-3c'],
    });
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage,
          broadcast: vi.fn(),
          getTeamFile: () => ({
            leadAgentId: 'lead-1',
            members: [{ name: 'alice' }],
          }),
        },
      }),
    );

    // The padded spellings are the regression: `resolvePeerTarget` trims its
    // target while the in-process check matches exactly, so without a single
    // normalization `"leader "` skipped the reservation and was delivered to
    // whatever peer session happened to carry that name.
    for (const to of ['leader', 'Leader', 'lead-1', 'leader ', '\nlead-1']) {
      sendMessage.mockClear();
      const result = await runWithTeammateIdentity(
        {
          agentName: 'alice',
          teamName: 'team',
          agentId: 'alice@team',
          isTeamLead: false,
        },
        () =>
          tool
            .build({ to, message: 'report' })
            .execute(new AbortController().signal),
      );
      expect(result.error).toBeUndefined();
      expect(sendMessage).toHaveBeenCalledWith(
        to.trim(),
        'report',
        'alice',
        undefined,
      );
    }
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('says a teammate was searched too when a name resolves nowhere', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'not-found',
      suggestions: ['docs-cd'],
    });
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: { sendMessage: vi.fn(), broadcast: vi.fn() },
      }),
    );
    const result = await tool
      .build({ to: 'docs', message: 'hi' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('and no teammate');
    expect(result.llmContent).toContain('docs-cd');
  });

  it("appends the session search to the team's not-found error", async () => {
    sendToPeer.mockResolvedValue({ kind: 'not-found', suggestions: [] });
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi
            .fn()
            .mockRejectedValue(new Error('Teammate "zed" not found.')),
          broadcast: vi.fn(),
        },
      }),
    );
    const result = await tool
      .build({ to: 'zed', message: 'hi' })
      .execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('Teammate "zed" not found.');
    expect(result.llmContent).toContain(
      'No reachable session has that name either',
    );
  });

  it("names the disabled setting in the team's not-found error", async () => {
    sendToPeer.mockResolvedValue({ kind: 'disabled' });
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi
            .fn()
            .mockRejectedValue(new Error('Teammate "zed" not found.')),
          broadcast: vi.fn(),
        },
      }),
    );
    const result = await tool
      .build({ to: 'zed', message: 'hi' })
      .execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('Teammate "zed" not found.');
    expect(result.llmContent).toContain('agents.crossSessionMessaging');
    expect(result.llmContent).not.toContain(
      'No reachable session has that name',
    );
  });

  it('says messaging is off, rather than that a lookup found nothing', async () => {
    sendToPeer.mockResolvedValue({ kind: 'disabled' });
    const result = await toolWithoutTeam()
      .build({ to: 'docs-cd', message: 'hi' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('No active team');
    expect(result.llmContent).toContain('agents.crossSessionMessaging');
    expect(result.llmContent).not.toContain('no reachable session');
  });

  it('tells the model it will not learn the outcome and must not re-send', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'sent',
      address: 'docs-cd',
      peer: { cwd: '/w/docs' },
    });
    const result = await toolWithoutTeam()
      .build({ to: 'docs-cd', message: 'hi' })
      .execute(new AbortController().signal);
    expect(result.llmContent).toContain('do not re-send');
    expect(result.llmContent).toContain('<cross_session_message>');
  });

  it('hands the peer route a reservation rule that mirrors its own routing', async () => {
    sendToPeer.mockResolvedValue({ kind: 'not-found', suggestions: [] });
    const tool = new SendMessageTool(
      makeTeamConfig({
        teamManager: {
          sendMessage: vi
            .fn()
            .mockRejectedValue(new Error('Teammate "x" not found.')),
          broadcast: vi.fn(),
          getTeamFile: () => ({
            leadAgentId: 'lead-1',
            members: [{ name: 'alice' }],
          }),
        },
      }),
    );
    await tool
      .build({ to: 'zed', message: 'hi' })
      .execute(new AbortController().signal);
    const isReserved = sendToPeer.mock.calls[0][0].isReserved as (
      address: string,
    ) => boolean;
    expect(isReserved('*')).toBe(true);
    expect(isReserved('leader')).toBe(true);
    expect(isReserved('lead-1')).toBe(true);
    expect(isReserved('Alice')).toBe(true);
    expect(isReserved('docs-cd')).toBe(false);

    sendToPeer.mockClear();
    await toolWithoutTeam()
      .build({ to: 'zed', message: 'hi' })
      .execute(new AbortController().signal);
    const noTeam = sendToPeer.mock.calls[0][0].isReserved as (
      address: string,
    ) => boolean;
    expect(noTeam('*')).toBe(true);
    expect(noTeam('leader')).toBe(false);
  });

  it('warns the model off permission laundering in the tool description', () => {
    expect(toolWithoutTeam().description).toContain(
      'perform an action this session was denied',
    );
  });
});

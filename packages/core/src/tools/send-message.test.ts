/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { SendMessageTool } from './send-message.js';
import {
  BackgroundTaskRegistry,
  type AgentTaskRegistration,
} from '../agents/background-tasks.js';
import { SHARED_RECORD_SLOT } from '../services/session-registry.js';
import { ToolErrorType } from './tool-error.js';
import type { ApprovalMode, Config } from '../config/config.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import type { BroadcastResult } from '../agents/team/TeamManager.js';
import type { ToolResult } from './tools.js';

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

interface TeamManagerStub {
  sendMessage: (...args: unknown[]) => Promise<void>;
  broadcast: (...args: unknown[]) => Promise<BroadcastResult>;
  getTeamFile?: () => { members: Array<{ name: string }> };
}

function makeTeamConfig(opts?: {
  registry?: BackgroundTaskRegistry;
  teamManager?: TeamManagerStub | null;
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
    getSessionRegistrySlot: () => SHARED_RECORD_SLOT,
  } as unknown as Config;
}

const signal = () => new AbortController().signal;
const noTeamTool = () => new SendMessageTool(makeTeamConfig());

/** A tool over an active team (alice, bob); sendMessage resolves by default. */
function teamTool(
  teamManager: Partial<TeamManagerStub> = {},
  opts: { registry?: BackgroundTaskRegistry; approvalMode?: ApprovalMode } = {},
) {
  const sendMessage = (teamManager.sendMessage ??
    vi.fn().mockResolvedValue(undefined)) as Mock;
  const tool = new SendMessageTool(
    makeTeamConfig({
      ...opts,
      teamManager: { broadcast: vi.fn(), ...teamManager, sendMessage },
    }),
  );
  return { tool, sendMessage };
}

function run(tool: SendMessageTool, to: string, message = 'hi') {
  return tool.build({ to, message }).execute(signal());
}

function asTeammate<T>(
  agentName: string,
  fn: () => T,
  extra: { planModeRequired?: boolean } = {},
) {
  const agentId = `${agentName}@team`;
  return runWithTeammateIdentity(
    { agentName, teamName: 'team', agentId, isTeamLead: false, ...extra },
    fn,
  );
}

function registerTask(
  registry: BackgroundTaskRegistry,
  overrides: Partial<AgentTaskRegistration> = {},
) {
  registry.register({
    agentId: 'agent-1',
    description: 'test agent',
    status: 'running',
    startTime: Date.now(),
    abortController: new AbortController(),
    isBackgrounded: true,
    outputFile: '/tmp/test.jsonl',
    ...overrides,
  });
}

/** `call` is [to, message, from]: the team delivered it with no summary. */
function expectDelivered(sendMessage: Mock, ...call: string[]) {
  expect(sendMessage).toHaveBeenCalledWith(...call, undefined);
}

function expectLlm(result: ToolResult, has: string[], lacks: string[] = []) {
  for (const s of has) expect(result.llmContent).toContain(s);
  for (const s of lacks) expect(result.llmContent).not.toContain(s);
}

describe('SendMessageTool — team mode', () => {
  it('has the correct name', () => {
    expect(noTeamTool().name).toBe('send_message');
    expect(noTeamTool().description).toContain(
      'In Direct mode: If the list_agents tool is not in your tool list, review its schema with `tool_search` and then invoke it with `tool_call`.',
    );
    expect(noTeamTool().description).toContain(
      'If tool_search does not offer list_agents in this context, do not invoke it; use a known teammate name or task_id.',
    );
  });

  it('describes text invisibility as peer-only for teammates', () => {
    const tool = noTeamTool();
    expect(tool.description).toContain(
      'Your text output is NOT visible to teammates or to other sessions',
    );
    expect(tool.description).not.toContain('NOT visible to other agents');
  });

  it('sends a message via TeamManager', async () => {
    const { tool, sendMessage } = teamTool();

    const result = await run(tool, 'alice', 'hello');
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('alice');
    expectDelivered(sendMessage, 'alice', 'hello', 'leader');
  });

  it('broadcasts with "*"', async () => {
    const broadcast = vi
      .fn()
      .mockResolvedValue({ total: 2, failedRecipients: [] });
    const { tool } = teamTool({ sendMessage: vi.fn(), broadcast });

    const result = await run(tool, '*', 'hey all');
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('broadcast');
    expect(broadcast).toHaveBeenCalledWith('hey all', 'leader');
  });

  it('returns error when no team is active and no task_id given', async () => {
    const result = await run(noTeamTool(), 'alice', 'hello');
    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('No active team');
  });

  // #9276: an optional single-value enum `type: ['shutdown_request']`,
  // described as "structured message type for control flow", got filled in
  // ordinary reports; the call was rejected leader-only and the report
  // discarded. The field is gone: assert its *absence*, since a reworded
  // description would still leave the state representable.
  it('exposes no control discriminator on the schema', () => {
    const schema = noTeamTool().schema.parametersJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).not.toContain('type');
    expect(JSON.stringify(schema)).not.toContain('shutdown_request');
  });

  it('rejects an empty message at build time', () => {
    expect(() => noTeamTool().build({ to: 'alice', message: '' })).toThrow(
      /message/i,
    );
  });

  it("delivers a teammate's ordinary message to the leader", async () => {
    const { tool, sendMessage } = teamTool();

    const report = 'Task completed and verified';
    const result = await asTeammate('worker', () =>
      run(tool, 'leader', report),
    );

    expect(result.error).toBeUndefined();
    expectDelivered(sendMessage, 'leader', report, 'worker');
  });

  it('blocks plan-required teammates before leader approval', async () => {
    const { tool, sendMessage } = teamTool({}, { approvalMode: PLAN_MODE });

    const result = await asTeammate(
      'planner',
      () => run(tool, 'alice', 'execute this before approval'),
      { planModeRequired: true },
    );

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('waiting for leader approval');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('validates required params', () => {
    const tool = noTeamTool();
    // `message` is required.
    expect(() => tool.build({} as never)).toThrow();
    expect(() => tool.build({ to: 'alice' } as never)).toThrow();
  });

  it('rejects ambiguous teammate and background-task destinations', async () => {
    const registry = new BackgroundTaskRegistry();
    registerTask(registry);
    const { tool, sendMessage } = teamTool({}, { registry });

    const result = await tool.validateBuildAndExecute(
      { to: 'alice', task_id: 'agent-1', message: 'ambiguous destination' },
      signal(),
    );

    expect(result.error?.type).toBe(ToolErrorType.INVALID_TOOL_PARAMS);
    expect(result.llmContent).toContain('Only one of "to" or "task_id"');
    expect(registry.get('agent-1')!.pendingMessages).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('SendMessageTool — background-task mode', () => {
  let registry: BackgroundTaskRegistry;
  let tool: SendMessageTool;
  let resumeBackgroundAgent: ReturnType<typeof vi.fn>;
  let reviveCompletedBackgroundAgent: ReturnType<typeof vi.fn>;
  const COMPLETED = {
    status: 'completed',
    metaPath: '/tmp/test.meta.json',
  } as const;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    resumeBackgroundAgent = vi.fn();
    reviveCompletedBackgroundAgent = vi.fn();
    tool = new SendMessageTool({
      getBackgroundTaskRegistry: () => registry,
      getTeamManager: () =>
        ({
          getTeamFile: () => ({ members: [{ name: 'qa-reviewer' }] }),
        }) as ReturnType<Config['getTeamManager']>,
      resumeBackgroundAgent,
      reviveCompletedBackgroundAgent,
    } as unknown as Config);
  });

  const register = (overrides: Partial<AgentTaskRegistration> = {}) =>
    registerTask(registry, overrides);
  const send = (message: string, task_id = 'agent-1', via = tool) =>
    via.validateBuildAndExecute({ task_id, message }, signal());
  const pending = () => registry.get('agent-1')!.pendingMessages;

  /** Not-found for task "nope" with no teammate hint in either output. */
  function expectPlainNotFound(result: ToolResult) {
    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('No background task found');
    expect(result.llmContent).not.toContain('use `to:');
    expect(result.returnDisplay).toContain('Task not found.');
    expect(result.returnDisplay).not.toContain('use "to"');
  }

  it('queues a message for a running task', async () => {
    register();

    const result = await send('do more work');

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('Message queued');
    // The caller must not sit waiting for an inline answer, nor start a
    // replacement task while the original is still holding the message.
    expect(result.llmContent).toContain('There is no inline reply');
    expect(result.llmContent).toContain(
      'Do not relaunch the task while waiting',
    );
    expect(pending()).toEqual(['do more work']);
  });

  it('queues multiple messages in order', async () => {
    register();

    await send('first');
    await send('second');

    expect(pending()).toEqual(['first', 'second']);
  });

  it('revives a task when it finishes while a message waits at the finalization boundary', async () => {
    register();
    registry.beginFinishing('agent-1');
    reviveCompletedBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const resultPromise = send('late correction');
    await Promise.resolve();

    expect(pending()).toEqual([]);
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
    const result = await send('hello', 'nope');

    expectPlainNotFound(result);
    expect(result.error?.message).toBe('Task not found: nope');
  });

  it('returns error for non-existent task without an active team', async () => {
    const noTeamTool = new SendMessageTool(
      makeTeamConfig({ registry, teamManager: null }),
    );
    expectPlainNotFound(await send('hello', 'nope', noTeamTool));
  });

  it('suggests the teammate destination for a matching task ID', async () => {
    const result = await send('hello', 'QA Reviewer');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.error?.message).toContain(
      'use `to: "qa-reviewer"` instead of `task_id`',
    );
    expect(result.llmContent).toContain('use `to: "qa-reviewer"`');
    expect(result.returnDisplay).toContain(
      'use "to" for teammate "qa-reviewer"',
    );
  });

  it('returns error for a failed (non-running, non-revivable) task', async () => {
    register();
    registry.fail('agent-1', 'boom');

    const result = await send('hello');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('not running');
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
  });

  it('rejects messages for a cancelled task', async () => {
    // Once task_stop fires the reasoning loop is winding down, with no next
    // tool-round boundary to drain into: an accepted message would be silently
    // dropped and never delivered, so reject it instead.
    register();
    registry.cancel('agent-1');

    const result = await send('too late');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(pending()).toEqual([]);
  });

  it('resumes a paused task and injects the message as continuation input', async () => {
    register({ status: 'paused' });
    resumeBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const result = await send('pick up from the TODO list');

    expect(resumeBackgroundAgent).toHaveBeenCalledWith(
      'agent-1',
      'pick up from the TODO list',
    );
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('resumed');
  });

  it('continues a completed task on its resident runtime', async () => {
    register(COMPLETED);
    const continueResident = vi.fn().mockReturnValue('continued');
    registry.registerResidentAgent('agent-1', {
      continue: continueResident,
      dispose: vi.fn(),
    });

    const result = await send('now refactor the helper');

    expect(continueResident).toHaveBeenCalledWith('now refactor the helper');
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
    expect(resumeBackgroundAgent).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('existing runtime');
    expect(result.returnDisplay).toContain('Continued');
  });

  it('reports resident capacity without attempting a cold revive', async () => {
    register(COMPLETED);
    registry.registerResidentAgent('agent-1', {
      continue: vi.fn().mockReturnValue('capacity_wait'),
      dispose: vi.fn(),
    });

    const result = await send('now refactor the helper');

    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('capacity');
  });

  it('revives a completed task when no resident runtime is available', async () => {
    register(COMPLETED);
    reviveCompletedBackgroundAgent.mockResolvedValue(registry.get('agent-1'));

    const result = await send('now refactor the helper');

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
    register(COMPLETED);
    reviveCompletedBackgroundAgent.mockResolvedValue(undefined);

    const result = await send('try again');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain('could not be revived');
  });

  it('reports the retained-state reason without attempting continuation', async () => {
    register({
      ...COMPLETED,
      description: 'unsafe restored agent',
      resumeBlockedReason: 'Background task transcript is missing.',
    });

    const result = await send('try again');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expect(result.llmContent).toContain(
      'Background task transcript is missing.',
    );
    expect(reviveCompletedBackgroundAgent).not.toHaveBeenCalled();
    expect(resumeBackgroundAgent).not.toHaveBeenCalled();
  });

  it('includes task description in success display', async () => {
    register({ description: 'Search for auth code' });

    const result = await send('focus on login');

    expect(result.returnDisplay).toContain('Search for auth code');
  });
});

describe('SendMessageTool — destination validation (#10073)', () => {
  /** Looks up `task_id` with an empty registry and a team file `teamFile`. */
  function lookup(teamFile: object, task_id: string) {
    const tool = new SendMessageTool({
      getBackgroundTaskRegistry: () => new BackgroundTaskRegistry(),
      getApprovalMode: () => DEFAULT_MODE,
      getTeamManager: () => ({ getTeamFile: () => teamFile }),
    } as unknown as Config);
    return tool.validateBuildAndExecute(
      { task_id, message: 'hello' },
      signal(),
    );
  }

  it('rejects calls that specify both "to" and "task_id" at build time', () => {
    expect(() =>
      noTeamTool().build({ to: 'alice', task_id: 'agent-1', message: 'hello' }),
    ).toThrow('Only one of "to" or "task_id" may be provided.');
  });

  it('declares the two destination fields mutually exclusive', () => {
    expect(noTeamTool().description).toContain(
      'Specify exactly one of the two fields',
    );
  });

  it('suggests "to" when a failed task_id matches a teammate name', async () => {
    const result = await lookup(
      { members: [{ agentId: 'qa-reviewer@team', name: 'qa-reviewer' }] },
      'QA Reviewer',
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    // The scheduler builds the model-facing error response from
    // error.message, so assert there — not on llmContent, which an
    // errored ToolResult never forwards to the model.
    expect(result.error?.message).toContain('Task not found');
    expect(result.error?.message).toContain('use `to: "qa-reviewer"`');
    expect(result.error?.message).toContain('instead of `task_id`');
  });

  // Rows: title, team file, task_id, whether error.message suggests `to`.
  it.each([
    [
      'adds no teammate hint when the task_id matches no teammate',
      { members: [{ agentId: 'alice@team', name: 'alice' }] },
      'definitely-not-a-teammate',
      false,
    ],
    [
      'suggests "to" when the task_id is the reserved leader name',
      { members: [] },
      'Leader',
      true,
    ],
    [
      'adds no hint for leader spellings the "to" route would reject',
      { members: [] },
      'Leader!',
      false,
    ],
    [
      'suggests "to" when the task_id is the leader agent ID',
      { members: [], leadAgentId: 'leader@test-team' },
      'leader@test-team',
      true,
    ],
  ])('%s', async (_title, teamFile, taskId, hinted) => {
    const result = await lookup(teamFile, taskId);

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    if (hinted) expect(result.error?.message).toContain('instead of `task_id`');
    else expect(result.error?.message).not.toContain('use `to:');
  });
});

describe('SendMessageTool — peer mode', () => {
  const sentReply = () => ({
    kind: 'sent',
    address: 'docs-cd',
    peer: { cwd: '/w/docs' },
  });
  const leadTeamFile = () => ({
    leadAgentId: 'lead-1',
    members: [{ name: 'alice' }],
  });
  const rejectsNotFound = (name: string) =>
    vi.fn().mockRejectedValue(new Error(`Teammate "${name}" not found.`));
  /** No active team; the peer route answers `response`. */
  const peerSend = (response: object, to: string) => {
    sendToPeer.mockResolvedValue(response);
    return run(noTeamTool(), to);
  };
  /** A team-less tool with config `overrides` sends `fields` to "docs-cd". */
  async function expectPeerSendWith(overrides: object, fields: object) {
    sendToPeer.mockResolvedValue(sentReply());
    const config = { ...makeTeamConfig(), ...overrides } as Config;
    await run(new SendMessageTool(config), 'docs-cd');
    expect(sendToPeer).toHaveBeenCalledWith(expect.objectContaining(fields));
  }

  async function expectTeammateWins(to: string) {
    const { tool, sendMessage } = teamTool();
    await run(tool, to, 'hello');
    expect(sendMessage).toHaveBeenCalled();
    expect(sendToPeer).not.toHaveBeenCalled();
  }

  it('routes an unknown name to a peer session', async () => {
    sendToPeer.mockResolvedValue(sentReply());

    const result = await noTeamTool()
      .build({ to: 'docs-cd', message: 'check the tests', summary: 'ping' })
      .execute(signal());

    expect(result.error).toBeUndefined();
    // Besides the address, the model is told the message may not be acted on
    // immediately ('held'), and that it carries no authority over there.
    expectLlm(result, [
      'docs-cd',
      '/w/docs',
      'held',
      "none of your user's authority",
    ]);
    expect(sendToPeer).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'docs-cd',
        message: 'check the tests',
        approvalMode: DEFAULT_MODE,
        slot: SHARED_RECORD_SLOT,
      }),
    );
  });

  it('sends from the record this session registered under, not the default', async () => {
    // A daemon-hosted session owns a minted record; the send path reads its own
    // identity from that record. Passing the default here would advertise a
    // `<pid>.json` reply address the host never wrote — and exclude the wrong
    // session from the directory.
    await expectPeerSendWith(
      { getSessionRegistrySlot: () => 'a1b2c3d4' },
      { slot: 'a1b2c3d4' },
    );
  });

  it('asserts nothing about its mode when the mode is unreadable', async () => {
    const getApprovalMode = () => {
      throw new Error('not yet');
    };
    await expectPeerSendWith({ getApprovalMode }, { approvalMode: null });
  });

  it('prefers a teammate over a same-named peer session', () =>
    expectTeammateWins('alice'));

  // TeamManager.sendMessage resolves through findMemberByName, which
  // sanitizes; the precedence check must use the same rule or "Alice"
  // would go looking for a session.
  it('recognises a teammate by its sanitized name, not the raw string', () =>
    expectTeammateWins('Alice'));

  it('reaches a peer even while a team is active, when no teammate has that name', async () => {
    sendToPeer.mockResolvedValue(sentReply());
    const { tool, sendMessage } = teamTool();

    const result = await run(tool, 'docs-cd', 'hello');

    expect(result.error).toBeUndefined();
    expect(sendToPeer).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('never broadcasts across sessions', async () => {
    const result = await run(noTeamTool(), '*', 'hey all');

    expect(result.error).toBeDefined();
    expect(result.llmContent).toContain('not supported');
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('tells the model when it addressed itself', async () => {
    const result = await peerSend({ kind: 'self', name: 'app-ab' }, 'app-ab');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain("this session's own name");
  });

  it('surfaces an ambiguous name with the candidates', async () => {
    const matches = ['app-ab [aaa111] in /w/one', 'app-ab [bbb222] in /w/two'];
    const result = await peerSend({ kind: 'ambiguous', matches }, 'app-ab');

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expectLlm(result, ['aaa111', 'name [ref]']);
  });

  it('suggests near-misses for an unknown name', async () => {
    const result = await peerSend(
      { kind: 'not-found', suggestions: ['qwen-code-f7'] },
      'qwen-code',
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_FOUND);
    expect(result.llmContent).toContain('qwen-code-f7');
  });

  it('falls through to the team error when nothing resembles the name', async () => {
    const result = await peerSend(
      { kind: 'not-found', suggestions: [] },
      'zzz',
    );

    expect(result.error).toBeDefined();
    expectLlm(result, ['No active team', '"zzz"']);
  });

  it('reports a delivery failure against the address it tried', async () => {
    const result = await peerSend(
      { ...sentReply(), kind: 'failed', reason: 'that session just exited' },
      'docs-cd',
    );

    expect(result.error?.type).toBe(ToolErrorType.SEND_MESSAGE_NOT_RUNNING);
    expectLlm(result, ['docs-cd', 'just exited']);
  });

  it('falls through to the team error when messaging is off', async () => {
    const result = await peerSend({ kind: 'disabled' }, 'docs-cd');

    expect(result.llmContent).toContain('No active team');
  });

  it("never routes a teammate's report to the leader through the peer directory", async () => {
    // A session named "leaderboard-3c" is reachable: the peer route would
    // suggest it for "leader" and swallow the report.
    sendToPeer.mockResolvedValue({
      kind: 'not-found',
      suggestions: ['leaderboard-3c'],
    });
    const { tool, sendMessage } = teamTool({ getTeamFile: leadTeamFile });

    // The padded spellings are the regression: `resolvePeerTarget` trims its
    // target while the in-process check matches exactly, so without a single
    // normalization `"leader "` skipped the reservation and was delivered to
    // whatever peer session happened to carry that name.
    for (const to of ['leader', 'Leader', 'lead-1', 'leader ', '\nlead-1']) {
      sendMessage.mockClear();
      const result = await asTeammate('alice', () => run(tool, to, 'report'));
      expect(result.error).toBeUndefined();
      expectDelivered(sendMessage, to.trim(), 'report', 'alice');
    }
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('says a teammate was searched too when a name resolves nowhere', async () => {
    sendToPeer.mockResolvedValue({
      kind: 'not-found',
      suggestions: ['docs-cd'],
    });
    const { tool } = teamTool({ sendMessage: vi.fn() });

    expectLlm(await run(tool, 'docs'), ['and no teammate', 'docs-cd']);
  });

  it("appends the session search to the team's not-found error", async () => {
    sendToPeer.mockResolvedValue({ kind: 'not-found', suggestions: [] });
    const { tool } = teamTool({ sendMessage: rejectsNotFound('zed') });

    const result = await run(tool, 'zed');

    expect(result.error).toBeDefined();
    expectLlm(result, [
      'Teammate "zed" not found.',
      'No reachable session has that name either',
    ]);
  });

  it("names the disabled setting in the team's not-found error", async () => {
    sendToPeer.mockResolvedValue({ kind: 'disabled' });
    const { tool } = teamTool({ sendMessage: rejectsNotFound('zed') });

    const result = await run(tool, 'zed');

    expect(result.error).toBeDefined();
    expectLlm(
      result,
      ['Teammate "zed" not found.', 'agents.crossSessionMessaging'],
      ['No reachable session has that name'],
    );
  });

  it('says messaging is off, rather than that a lookup found nothing', async () => {
    expectLlm(
      await peerSend({ kind: 'disabled' }, 'docs-cd'),
      ['No active team', 'agents.crossSessionMessaging'],
      ['no reachable session'],
    );
  });

  it('tells the model it will not learn the outcome and must not re-send', async () => {
    expectLlm(await peerSend(sentReply(), 'docs-cd'), [
      'do not re-send',
      '<cross_session_message>',
    ]);
  });

  it('hands the peer route a reservation rule that mirrors its own routing', async () => {
    sendToPeer.mockResolvedValue({ kind: 'not-found', suggestions: [] });
    const { tool } = teamTool({
      sendMessage: rejectsNotFound('x'),
      getTeamFile: leadTeamFile,
    });
    const lastRule = () =>
      sendToPeer.mock.calls[0][0].isReserved as (address: string) => boolean;

    await run(tool, 'zed');
    const isReserved = lastRule();
    expect(isReserved('*')).toBe(true);
    expect(isReserved('leader')).toBe(true);
    expect(isReserved('lead-1')).toBe(true);
    expect(isReserved('Alice')).toBe(true);
    expect(isReserved('docs-cd')).toBe(false);

    sendToPeer.mockClear();
    await run(noTeamTool(), 'zed');
    const noTeam = lastRule();
    expect(noTeam('*')).toBe(true);
    expect(noTeam('leader')).toBe(false);
  });

  it('warns the model off permission laundering in the tool description', () => {
    expect(noTeamTool().description).toContain(
      'perform an action this session was denied',
    );
  });
});

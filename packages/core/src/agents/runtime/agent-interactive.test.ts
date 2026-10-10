/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getHookExecutionOwner,
  runWithHookExecutionOwner,
} from '../../hooks/hook-execution-context.js';

import { AgentInteractive } from './agent-interactive.js';
import type { AgentCore } from './agent-core.js';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import type {
  AgentRoundTextEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentToolOutputUpdateEvent,
} from './agent-events.js';
import { ContextState } from './agent-headless.js';
import type { AgentInteractiveConfig } from './agent-types.js';
import { AgentStatus, AgentTerminateMode } from './agent-types.js';
import { LoopType } from '../../telemetry/types.js';
import {
  getCurrentAgentDepth,
  getCurrentAgentId,
  runWithAgentContext,
} from './agent-context.js';
import { modelText, userText } from '../../test-utils/model-fixtures.js';

const summary = () => ({
  rounds: 1,
  totalDurationMs: 100,
  totalToolCalls: 0,
  successfulToolCalls: 0,
  failedToolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

function createMockCore(
  overrides: {
    nullChat?: boolean;
    loopResult?: {
      text: string;
      terminateMode: AgentTerminateMode | null;
      turnsUsed: number;
      loopType?: LoopType;
    };
  } = {},
) {
  const emitter = new AgentEventEmitter();
  const chatReturnValue = overrides.nullChat
    ? undefined
    : { sendMessageStream: vi.fn() };

  // Simulate the observable state that the real AgentCore now owns.
  // AgentInteractive delegates its state accessors to these, so the mock
  // needs to reflect mutations made via `pushMessage` / approval helpers.
  const messages: Array<Record<string, unknown>> = [];
  const pendingApprovals = new Map<string, unknown>();
  const liveOutputs = new Map<string, unknown>();
  const shellPids = new Map<string, number>();
  const pushMessage = (
    role: string,
    content: string,
    options?: { thought?: boolean; metadata?: Record<string, unknown> },
  ) => {
    const message: Record<string, unknown> = {
      role,
      content,
      timestamp: Date.now(),
    };
    if (options?.thought) message['thought'] = true;
    if (options?.metadata) message['metadata'] = options.metadata;
    messages.push(message);
  };

  const core = {
    subagentId: 'test-agent-abc123',
    runInHookFrame: <T>(fn: () => T): T =>
      runWithHookExecutionOwner(
        {
          runtimeId: 'runtime',
          sessionId: 'session',
          agentId: 'test-agent-abc123',
        },
        fn,
      ),
    name: 'test-agent',
    eventEmitter: emitter,
    stats: {
      start: vi.fn(),
      getSummary: vi.fn().mockReturnValue(summary()),
      setRounds: vi.fn(),
      recordToolCall: vi.fn(),
      recordTokens: vi.fn(),
    },
    createChat: vi.fn().mockResolvedValue(chatReturnValue),
    prepareTools: vi.fn().mockReturnValue([]),
    runReasoningLoop: vi
      .fn()
      .mockResolvedValue(overrides.loopResult ?? loopResult('Done')),
    getEventEmitter: () => emitter,
    getExecutionSummary: vi.fn().mockReturnValue(summary()),
    // Observable state surface (mirrors real AgentCore API).
    getMessages: () => messages,
    getPendingApprovals: () => pendingApprovals,
    getLiveOutputs: () => liveOutputs,
    getShellPids: () => shellPids,
    pushMessage,
    setPendingApproval: (callId: string, details: unknown) =>
      pendingApprovals.set(callId, details),
    deletePendingApproval: (callId: string) => pendingApprovals.delete(callId),
    clearPendingApprovals: () => pendingApprovals.clear(),
  } as unknown as AgentCore;

  // Mirror AgentCore.setupStateListeners (wired in the real constructor) so
  // tests that drive behavior by emitting events observe the same state.
  emitter.on(AgentEventType.ROUND_TEXT, (event: AgentRoundTextEvent) => {
    if (event.thoughtText) {
      pushMessage('assistant', event.thoughtText, { thought: true });
    }
    if (event.text) {
      pushMessage('assistant', event.text);
    }
  });
  emitter.on(AgentEventType.TOOL_CALL, (event: AgentToolCallEvent) => {
    pushMessage('tool_call', `Tool call: ${event.name}`, {
      metadata: {
        callId: event.callId,
        toolName: event.name,
        args: event.args,
        description: event.description,
        renderOutputAsMarkdown: event.isOutputMarkdown,
        round: event.round,
      },
    });
  });
  emitter.on(
    AgentEventType.TOOL_OUTPUT_UPDATE,
    (event: AgentToolOutputUpdateEvent) => {
      liveOutputs.set(event.callId, event.outputChunk);
      if (event.pid !== undefined) {
        shellPids.set(event.callId, event.pid);
      }
    },
  );
  emitter.on(AgentEventType.TOOL_RESULT, (event: AgentToolResultEvent) => {
    liveOutputs.delete(event.callId);
    shellPids.delete(event.callId);
    pendingApprovals.delete(event.callId);
    const statusText = event.success ? 'succeeded' : 'failed';
    const summary = event.error
      ? `Tool ${event.name} ${statusText}: ${event.error}`
      : `Tool ${event.name} ${statusText}`;
    pushMessage('tool_result', summary, {
      metadata: {
        callId: event.callId,
        toolName: event.name,
        success: event.success,
        resultDisplay: event.resultDisplay,
        outputFile: event.outputFile,
        round: event.round,
      },
    });
  });

  return { core, emitter };
}

function loopResult(text: string) {
  return { text, terminateMode: null, turnsUsed: 1 };
}

/** Replaces the mock core's reasoning-loop implementation. */
function mockLoop(core: AgentCore, impl: (...args: never[]) => unknown) {
  (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(impl);
}

function emitRoundText(
  emitter: AgentEventEmitter,
  text: string,
  thoughtText = '',
) {
  emitter.emit(AgentEventType.ROUND_TEXT, {
    subagentId: 'test',
    round: 1,
    text,
    thoughtText,
    timestamp: Date.now(),
  });
}

/** Emits round text, then a `read_file` call-1 tool call and its success. */
function emitToolRound(
  emitter: AgentEventEmitter,
  text: string,
  args: Record<string, unknown>,
  description: string,
) {
  emitRoundText(emitter, text);
  emitter.emit(AgentEventType.TOOL_CALL, {
    subagentId: 'test',
    round: 1,
    callId: 'call-1',
    name: 'read_file',
    args,
    description,
    timestamp: Date.now(),
  });
  emitter.emit(AgentEventType.TOOL_RESULT, {
    subagentId: 'test',
    round: 1,
    callId: 'call-1',
    name: 'read_file',
    success: true,
    timestamp: Date.now(),
  });
}

function createConfig(
  overrides: Partial<AgentInteractiveConfig> = {},
): AgentInteractiveConfig {
  return {
    agentId: 'agent-1',
    agentName: 'Test Agent',
    ...overrides,
  };
}

const waitForStatus = (agent: AgentInteractive, status: string) =>
  vi.waitFor(() => {
    expect(agent.getStatus()).toBe(status);
  });

describe('AgentInteractive', () => {
  let context: ContextState;

  beforeEach(() => {
    context = new ContextState();
  });

  /** Builds an agent from `createConfig(overrides)` and starts it. */
  const startAgent = async (
    core: AgentCore,
    overrides: Partial<AgentInteractiveConfig> = {},
  ) => {
    const agent = new AgentInteractive(createConfig(overrides), core);
    await agent.start(context);
    return agent;
  };
  /** Starts an agent with `initialTask` and waits for the round to settle. */
  const runInitialTask = async (core: AgentCore, initialTask: string) => {
    const agent = new AgentInteractive(createConfig({ initialTask }), core);
    await agent.start(context);
    await waitForStatus(agent, 'idle');
    return agent;
  };

  // ─── Lifecycle ──────────────────────────────────────────────

  it('should initialize and complete cleanly without initialTask', async () => {
    const agent = await startAgent(createMockCore().core);
    // No initialTask → agent is waiting on queue, status is still initializing.
    // Shutdown drains queue, loop exits normally → completed.
    await agent.shutdown();
    expect(agent.getStatus()).toBe('completed');
  });

  it('runs start() and the message loop inside the agent identity frame', async () => {
    // Regression (codex review): start() called prepareTools() outside any
    // runWithAgentContext frame, so in-process interactive agents (Arena,
    // in-process teammates) were depth-gated as the top-level session —
    // receiving the `agent` tool even at maxSubagentDepth=1 — and their
    // later `agent` calls were counted as top-level spawns.
    const { core } = createMockCore();
    let prepId: string | null = null;
    let prepDepth = -1;
    let loopId: string | null = null;
    let loopDepth = -1;
    (core.prepareTools as ReturnType<typeof vi.fn>).mockImplementation(() => {
      prepId = getCurrentAgentId();
      prepDepth = getCurrentAgentDepth();
      return [];
    });
    mockLoop(core, async () => {
      loopId = getCurrentAgentId();
      loopDepth = getCurrentAgentDepth();
      return loopResult('Done');
    });

    await runInitialTask(core, 'go');

    // Spawned from the top-level session → the agent's own frame is depth 0
    // (a level-1 agent), for schema preparation and reasoning rounds alike.
    expect(prepId).toBe('agent-1');
    expect(prepDepth).toBe(0);
    expect(loopId).toBe('agent-1');
    expect(loopDepth).toBe(0);
  });

  it('restores its hook owner during preparation and later queued rounds', async () => {
    const { core } = createMockCore();
    const seen: Array<{
      stage: string;
      owner: ReturnType<typeof getHookExecutionOwner>;
    }> = [];
    const record = (stage: string) =>
      seen.push({ stage, owner: getHookExecutionOwner() });
    vi.mocked(core.createChat).mockImplementation(async () => {
      record('chat');
      return { sendMessageStream: vi.fn() } as never;
    });
    vi.mocked(core.prepareTools).mockImplementation(async () => {
      record('prepare');
      return [];
    });
    vi.mocked(core.runReasoningLoop).mockImplementation(async () => {
      record('loop');
      return { text: 'Done', terminateMode: null, turnsUsed: 1 };
    });
    const agent = new AgentInteractive(createConfig(), core);
    const foreign = { runtimeId: 'other', sessionId: 'other', agentId: 'B' };
    await runWithHookExecutionOwner(foreign, async () => {
      await agent.start(context);
      expect(getHookExecutionOwner()).toEqual(foreign);
      agent.enqueueMessage('later round');
      await vi.waitFor(() =>
        expect(seen.some(({ stage }) => stage === 'loop')).toBe(true),
      );
      expect(getHookExecutionOwner()).toEqual(foreign);
    });
    expect(seen.map(({ stage }) => stage)).toEqual(['chat', 'prepare', 'loop']);
    for (const { owner } of seen)
      expect(owner).toEqual({
        runtimeId: 'runtime',
        sessionId: 'session',
        agentId: 'test-agent-abc123',
      });
    await agent.shutdown();
  });

  it('pins the construction-time depth when built inside a sub-agent frame', async () => {
    // A nested in-process interactive agent captures childLaunchDepth() at
    // construction. start() runs OUTSIDE the parent's frame here, so a
    // measured depth of 1 proves the pin — without it the agent would be
    // framed as depth 0 (top-level spawn) and regain spawn capacity.
    const { core } = createMockCore();
    let prepDepth = -1;
    let loopDepth = -1;
    (core.prepareTools as ReturnType<typeof vi.fn>).mockImplementation(() => {
      prepDepth = getCurrentAgentDepth();
      return [];
    });
    mockLoop(core, async () => {
      loopDepth = getCurrentAgentDepth();
      return loopResult('Done');
    });

    const agent = await runWithAgentContext(
      'parent-agent',
      async () =>
        new AgentInteractive(createConfig({ initialTask: 'go' }), core),
    );
    await agent.start(context);
    await waitForStatus(agent, 'idle');

    expect(prepDepth).toBe(1);
    expect(loopDepth).toBe(1);
  });

  it('should process initialTask immediately on start', async () => {
    const { core } = createMockCore();
    const agent = await runInitialTask(core, 'Do something');

    expect(core.runReasoningLoop).toHaveBeenCalledOnce();
    expect(agent.getMessages().length).toBeGreaterThan(0);
    expect(agent.getMessages()[0]?.role).toBe('user');
    expect(agent.getMessages()[0]?.content).toBe('Do something');

    await agent.shutdown();
    expect(agent.getStatus()).toBe('completed');
  });

  it('should process enqueued messages', async () => {
    const { core } = createMockCore();
    const agent = await startAgent(core);

    agent.enqueueMessage('Hello');
    await waitForStatus(agent, 'idle');

    expect(core.runReasoningLoop).toHaveBeenCalledOnce();

    await agent.shutdown();
  });

  it('surfaces the exact loop detector in the interactive stop message (issue #9450)', async () => {
    // A loop stop must name its detector (issue #9450 requirement #7): the
    // visible info message and lastRoundError both carry the LoopType, so a
    // future regression collapsing stops back into the generic label fails
    // here instead of shipping unattributable stops.
    const { core } = createMockCore({
      loopResult: {
        text: '',
        terminateMode: AgentTerminateMode.LOOP_DETECTED,
        turnsUsed: 3,
        loopType: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      },
    });
    // Built inline: an extra async hop before the waitFor shifts its timing.
    const agent = new AgentInteractive(
      createConfig({ initialTask: 'go' }),
      core,
    );
    await agent.start(context);
    // A loop-detected round settles the agent as failed (the round error
    // path); the stop message must already have been pushed by then.
    await vi.waitFor(() => {
      expect(['idle', 'failed']).toContain(agent.getStatus());
    });
    await vi.waitFor(() => {
      expect(agent.getMessages().some((m) => m.role === 'info')).toBe(true);
    });

    const stopMessages = agent
      .getMessages()
      .filter((m) => m.role === 'info')
      .map((m) => String(m.content));
    expect(stopMessages).toContain(
      'Agent stopped: duplicate tool-call loop detected (consecutive_identical_tool_calls).',
    );

    await agent.shutdown();
  });

  it('should set status to failed when chat creation fails', async () => {
    const agent = await startAgent(createMockCore({ nullChat: true }).core);

    expect(agent.getStatus()).toBe('failed');
    expect(agent.getError()).toBe('Failed to create chat session');
  });

  // ─── Error Recovery ────────────────────────────────────────

  it('should survive round errors and recover', async () => {
    const { core } = createMockCore();

    let callCount = 0;
    mockLoop(core, () => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Model error'));
      }
      return Promise.resolve(loopResult('Recovered'));
    });

    const agent = await startAgent(core);

    agent.enqueueMessage('cause error');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('failed');
      expect(callCount).toBe(1);
    });

    // Error recorded as info message with error level
    const errorMsg = agent
      .getMessages()
      .find(
        (m) =>
          m.role === 'info' &&
          m.content.includes('Model error') &&
          m.metadata?.['level'] === 'error',
      );
    expect(errorMsg).toBeDefined();

    // Second message works fine
    agent.enqueueMessage('recover');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
      expect(callCount).toBe(2);
    });

    await agent.shutdown();
  });

  // ─── Cancellation ──────────────────────────────────────────

  it('should cancel current round without killing the agent', async () => {
    const { core } = createMockCore();
    let resolveLoop: () => void;
    mockLoop(
      core,
      () =>
        new Promise<{ text: string; terminateMode: string; turnsUsed: number }>(
          (resolve) => {
            resolveLoop = () =>
              resolve({ text: '', terminateMode: 'cancelled', turnsUsed: 0 });
          },
        ),
    );

    const agent = await startAgent(core);

    agent.enqueueMessage('long task');
    await waitForStatus(agent, 'running');

    agent.cancelCurrentRound();
    resolveLoop!();

    await waitForStatus(agent, 'idle');

    await agent.shutdown();
  });

  it('processes a message enqueued synchronously during the IDLE status emit', async () => {
    // Regression: TeamManager's status bridge flushes a held message the
    // instant a teammate settles to IDLE — synchronously, from inside the
    // STATUS_CHANGE emit. At that point the run loop has already passed
    // its final empty-queue check but `processing` is still true, so
    // enqueueMessage won't restart the loop; without the run-loop
    // re-check the message strands in a dead queue forever.
    const { core, emitter } = createMockCore();
    const processed: string[] = [];
    mockLoop(
      core,
      (
        _chat: unknown,
        initialMessages: Array<{ parts: [{ text: string }] }>,
      ) => {
        processed.push(initialMessages[0]!.parts[0].text);
        return Promise.resolve(loopResult('ok'));
      },
    );
    const agent = await startAgent(core);

    let flushedOnce = false;
    emitter.on(AgentEventType.STATUS_CHANGE, (payload) => {
      if (payload.newStatus === AgentStatus.IDLE && !flushedOnce) {
        flushedOnce = true;
        agent.enqueueMessage('flushed message');
      }
    });

    agent.enqueueMessage('first message');

    await vi.waitFor(() => {
      expect(processed).toEqual(['first message', 'flushed message']);
      expect(agent.getStatus()).toBe('idle');
    });

    await agent.shutdown();
  });

  it('reaches a terminal status when aborted while idle', async () => {
    // Regression: abort() on an agent with no run loop in flight used to
    // only set the signal — nothing observed it, so the agent never
    // reached a terminal status and terminal-status cleanup never fired.
    const agent = await startAgent(createMockCore().core);

    agent.enqueueMessage('task');
    await waitForStatus(agent, 'idle');

    agent.abort();
    expect(agent.getStatus()).toBe('cancelled');
    await agent.waitForCompletion();
  });

  it('reaches a terminal status when aborted before any message', async () => {
    const agent = await startAgent(createMockCore().core);

    agent.abort();
    expect(agent.getStatus()).toBe('cancelled');
  });

  it('should abort immediately', async () => {
    const { core } = createMockCore();
    mockLoop(
      core,
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                text: '',
                terminateMode: 'cancelled',
                turnsUsed: 0,
              }),
            50,
          );
        }),
    );

    const agent = await startAgent(core, { initialTask: 'long task' });
    agent.abort();

    await agent.waitForCompletion();
    expect(agent.getStatus()).toBe('cancelled');
  });

  // ─── Accessors ─────────────────────────────────────────────

  it('should provide stats via getStats()', async () => {
    const agent = new AgentInteractive(createConfig(), createMockCore().core);

    const stats = agent.getStats();
    expect(stats).toBeDefined();
    expect(stats.rounds).toBe(1);
  });

  it('should provide core via getCore()', () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    expect(agent.getCore()).toBe(core);
  });

  // ─── Message Recording ─────────────────────────────────────

  it('should record assistant text from ROUND_TEXT events', async () => {
    const { core, emitter } = createMockCore();
    mockLoop(core, () => {
      emitRoundText(emitter, 'Hello from round');
      return Promise.resolve(loopResult('Hello from round'));
    });

    const agent = await runInitialTask(core, 'test');

    const assistantMsgs = agent
      .getMessages()
      .filter((m) => m.role === 'assistant' && !m.thought);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.content).toBe('Hello from round');

    await agent.shutdown();
  });

  it('should not cross-contaminate text across messages', async () => {
    const { core, emitter } = createMockCore();

    let runCount = 0;
    mockLoop(core, () => {
      runCount++;
      emitRoundText(emitter, `response-${runCount}`);
      return Promise.resolve(loopResult(`response-${runCount}`));
    });

    const agent = await runInitialTask(core, 'first message');

    agent.enqueueMessage('second message');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
      expect(runCount).toBe(2);
    });

    const corrupted = agent
      .getMessages()
      .filter((m) => m.role === 'assistant' && !m.thought)
      .find(
        (m) =>
          m.content.includes('response-1') && m.content.includes('response-2'),
      );
    expect(corrupted).toBeUndefined();

    await agent.shutdown();
  });

  it('should capture thinking text as assistant messages with thought=true', async () => {
    const { core, emitter } = createMockCore();
    mockLoop(core, () => {
      emitRoundText(emitter, 'Here is the answer', 'Let me think...');
      return Promise.resolve(loopResult('Here is the answer'));
    });

    const agent = await runInitialTask(core, 'think about this');

    const messages = agent.getMessages();
    const thoughtMsg = messages.find(
      (m) => m.role === 'assistant' && m.thought === true,
    );
    const textMsg = messages.find((m) => m.role === 'assistant' && !m.thought);

    expect(thoughtMsg).toBeDefined();
    expect(thoughtMsg?.content).toBe('Let me think...');
    expect(textMsg).toBeDefined();
    expect(textMsg?.content).toBe('Here is the answer');

    await agent.shutdown();
  });

  it('should record tool_call and tool_result with correct roles', async () => {
    const { core, emitter } = createMockCore();
    mockLoop(core, () => {
      emitToolRound(
        emitter,
        'I will read the file',
        { path: 'test.ts' },
        'Read test.ts',
      );
      return Promise.resolve(loopResult(''));
    });

    const agent = await runInitialTask(core, 'read a file');

    const messages = agent.getMessages();
    const toolCall = messages.find((m) => m.role === 'tool_call');
    const toolResult = messages.find((m) => m.role === 'tool_result');

    expect(toolCall).toBeDefined();
    expect(toolCall?.metadata?.['toolName']).toBe('read_file');
    expect(toolCall?.metadata?.['callId']).toBe('call-1');

    expect(toolResult).toBeDefined();
    expect(toolResult?.metadata?.['success']).toBe(true);

    await agent.shutdown();
  });

  it('should place text before tool_call to preserve temporal ordering', async () => {
    const { core, emitter } = createMockCore();
    mockLoop(core, () => {
      emitToolRound(emitter, 'Let me check', {}, '');
      return Promise.resolve(loopResult(''));
    });

    const agent = await runInitialTask(core, 'task');

    const nonUser = agent.getMessages().filter((m) => m.role !== 'user');
    const textIdx = nonUser.findIndex(
      (m) => m.role === 'assistant' && m.content === 'Let me check',
    );
    const toolIdx = nonUser.findIndex((m) => m.role === 'tool_call');
    expect(textIdx).toBeLessThan(toolIdx);

    await agent.shutdown();
  });

  // ─── Chat History ────────────────────────────────────────────

  const chatHistory = [
    userText('earlier question'),
    modelText('earlier answer'),
  ];

  it('should pass chatHistory as extraHistory to createChat', async () => {
    const { core } = createMockCore();
    const agent = await startAgent(core, { chatHistory });

    expect(core.createChat).toHaveBeenCalledWith(context, {
      interactive: true,
      extraHistory: chatHistory,
    });

    await agent.shutdown();
  });

  it('should add info message when chatHistory is present', async () => {
    const agent = await startAgent(createMockCore().core, { chatHistory });

    const messages = agent.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'info',
      content: 'History context from parent session included (2 messages)',
    });

    await agent.shutdown();
  });

  it('should not add info message when chatHistory is absent', async () => {
    const agent = await startAgent(createMockCore().core);

    expect(agent.getMessages()).toHaveLength(0);

    await agent.shutdown();
  });

  it('should pass undefined extraHistory when chatHistory is not set', async () => {
    const { core } = createMockCore();
    const agent = await startAgent(core);

    expect(core.createChat).toHaveBeenCalledWith(context, {
      interactive: true,
      extraHistory: undefined,
    });

    await agent.shutdown();
  });

  // ─── Events ────────────────────────────────────────────────

  it('should emit status_change events', async () => {
    const { core, emitter } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    const statuses: AgentStatus[] = [];
    emitter.on(AgentEventType.STATUS_CHANGE, (payload) => {
      statuses.push(payload.newStatus);
    });

    await agent.start(context);
    await agent.shutdown();

    expect(statuses).toContain(AgentStatus.COMPLETED);
  });
});

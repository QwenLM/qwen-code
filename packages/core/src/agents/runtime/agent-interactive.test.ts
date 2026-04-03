/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentInteractive } from './agent-interactive.js';
import type { AgentCore, ReasoningLoopOptions } from './agent-core.js';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import { ContextState } from './agent-headless.js';
import type { AgentInteractiveConfig } from './agent-types.js';
import { AgentStatus } from './agent-types.js';

function createMockChat() {
  return {
    sendMessageStream: vi.fn(),
  };
}

function createMockCore(
  overrides: {
    chatValue?: unknown;
    nullChat?: boolean;
    loopResult?: { text: string; terminateMode: null; turnsUsed: number };
  } = {},
) {
  const emitter = new AgentEventEmitter();
  const chatReturnValue = overrides.nullChat
    ? undefined
    : overrides.chatValue !== undefined
      ? overrides.chatValue
      : createMockChat();
  const core = {
    subagentId: 'test-agent-abc123',
    name: 'test-agent',
    eventEmitter: emitter,
    stats: {
      start: vi.fn(),
      getSummary: vi.fn().mockReturnValue({
        rounds: 1,
        totalDurationMs: 100,
        totalToolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      setRounds: vi.fn(),
      recordToolCall: vi.fn(),
      recordTokens: vi.fn(),
    },
    createChat: vi.fn().mockResolvedValue(chatReturnValue),
    prepareTools: vi.fn().mockReturnValue([]),
    runReasoningLoop: vi.fn().mockResolvedValue(
      overrides.loopResult ?? {
        text: 'Done',
        terminateMode: null,
        turnsUsed: 1,
      },
    ),
    getEventEmitter: () => emitter,
    getExecutionSummary: vi.fn().mockReturnValue({
      rounds: 1,
      totalDurationMs: 100,
      totalToolCalls: 0,
      successfulToolCalls: 0,
      failedToolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
  } as unknown as AgentCore;

  return { core, emitter };
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

describe('AgentInteractive', () => {
  let context: ContextState;

  beforeEach(() => {
    context = new ContextState();
  });

  // ─── Lifecycle ──────────────────────────────────────────────

  it('should initialize and complete cleanly without initialTask', async () => {
    const { core } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    // No initialTask → agent is waiting on queue, status is still initializing.
    // Shutdown drains queue, loop exits normally → completed.
    await agent.shutdown();
    expect(agent.getStatus()).toBe('completed');
  });

  it('should process initialTask immediately on start', async () => {
    const { core } = createMockCore();
    const config = createConfig({ initialTask: 'Do something' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

    expect(core.runReasoningLoop).toHaveBeenCalledOnce();
    expect(agent.getMessages().length).toBeGreaterThan(0);
    expect(agent.getMessages()[0]?.role).toBe('user');
    expect(agent.getMessages()[0]?.content).toBe('Do something');

    await agent.shutdown();
    expect(agent.getStatus()).toBe('completed');
  });

  it('should process enqueued messages', async () => {
    const { core } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    agent.enqueueMessage('Hello');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

    expect(core.runReasoningLoop).toHaveBeenCalledOnce();

    await agent.shutdown();
  });

  it('should set status to failed when chat creation fails', async () => {
    const { core } = createMockCore({ nullChat: true });
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    expect(agent.getStatus()).toBe('failed');
    expect(agent.getError()).toBe('Failed to create chat session');
  });

  // ─── Error Recovery ────────────────────────────────────────

  it('should survive round errors and recover', async () => {
    const { core } = createMockCore();

    let callCount = 0;
    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Model error'));
        }
        return Promise.resolve({
          text: 'Recovered',
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    agent.enqueueMessage('cause error');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('failed');
      expect(callCount).toBe(1);
    });

    // Error recorded as info message with error level
    const messages = agent.getMessages();
    const errorMsg = messages.find(
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
    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<{ text: string; terminateMode: string; turnsUsed: number }>(
          (resolve) => {
            resolveLoop = () =>
              resolve({ text: '', terminateMode: 'cancelled', turnsUsed: 0 });
          },
        ),
    );

    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    agent.enqueueMessage('long task');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('running');
    });

    agent.cancelCurrentRound();
    resolveLoop!();

    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

    await agent.shutdown();
  });

  it('should abort immediately', async () => {
    const { core } = createMockCore();
    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
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

    const config = createConfig({ initialTask: 'long task' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    agent.abort();

    await agent.waitForCompletion();
    expect(agent.getStatus()).toBe('cancelled');
  });

  // ─── Accessors ─────────────────────────────────────────────

  it('should provide stats via getStats()', async () => {
    const { core } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    const stats = agent.getStats();
    expect(stats).toBeDefined();
    expect(stats.rounds).toBe(1);
  });

  it('should provide core via getCore()', () => {
    const { core } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    expect(agent.getCore()).toBe(core);
  });

  // ─── Message Recording ─────────────────────────────────────

  it('should record assistant text from ROUND_TEXT events', async () => {
    const { core, emitter } = createMockCore();

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'test',
          round: 1,
          text: 'Hello from round',
          thoughtText: '',
          timestamp: Date.now(),
        });
        return Promise.resolve({
          text: 'Hello from round',
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig({ initialTask: 'test' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

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
    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        runCount++;
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'test',
          round: 1,
          text: `response-${runCount}`,
          thoughtText: '',
          timestamp: Date.now(),
        });
        return Promise.resolve({
          text: `response-${runCount}`,
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig({ initialTask: 'first message' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

    agent.enqueueMessage('second message');
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
      expect(runCount).toBe(2);
    });

    const messages = agent.getMessages();
    const assistantMessages = messages.filter(
      (m) => m.role === 'assistant' && !m.thought,
    );
    const corrupted = assistantMessages.find(
      (m) =>
        m.content.includes('response-1') && m.content.includes('response-2'),
    );
    expect(corrupted).toBeUndefined();

    await agent.shutdown();
  });

  it('should capture thinking text as assistant messages with thought=true', async () => {
    const { core, emitter } = createMockCore();

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'test',
          round: 1,
          text: 'Here is the answer',
          thoughtText: 'Let me think...',
          timestamp: Date.now(),
        });
        return Promise.resolve({
          text: 'Here is the answer',
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig({ initialTask: 'think about this' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

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

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'test',
          round: 1,
          text: 'I will read the file',
          thoughtText: '',
          timestamp: Date.now(),
        });
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'test',
          round: 1,
          callId: 'call-1',
          name: 'read_file',
          args: { path: 'test.ts' },
          description: 'Read test.ts',
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
        return Promise.resolve({
          text: '',
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig({ initialTask: 'read a file' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

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

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        emitter.emit(AgentEventType.ROUND_TEXT, {
          subagentId: 'test',
          round: 1,
          text: 'Let me check',
          thoughtText: '',
          timestamp: Date.now(),
        });
        emitter.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'test',
          round: 1,
          callId: 'call-1',
          name: 'read_file',
          args: {},
          description: '',
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
        return Promise.resolve({
          text: '',
          terminateMode: null,
          turnsUsed: 1,
        });
      },
    );

    const config = createConfig({ initialTask: 'task' });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);
    await vi.waitFor(() => {
      expect(agent.getStatus()).toBe('idle');
    });

    const messages = agent.getMessages();
    const nonUser = messages.filter((m) => m.role !== 'user');

    const textIdx = nonUser.findIndex(
      (m) => m.role === 'assistant' && m.content === 'Let me check',
    );
    const toolIdx = nonUser.findIndex((m) => m.role === 'tool_call');
    expect(textIdx).toBeLessThan(toolIdx);

    await agent.shutdown();
  });

  // ─── Chat History ────────────────────────────────────────────

  it('should pass chatHistory as extraHistory to createChat', async () => {
    const { core } = createMockCore();
    const chatHistory = [
      { role: 'user' as const, parts: [{ text: 'earlier question' }] },
      { role: 'model' as const, parts: [{ text: 'earlier answer' }] },
    ];
    const config = createConfig({ chatHistory });
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    expect(core.createChat).toHaveBeenCalledWith(context, {
      interactive: true,
      extraHistory: chatHistory,
    });

    await agent.shutdown();
  });

  it('should add info message when chatHistory is present', async () => {
    const { core } = createMockCore();
    const chatHistory = [
      { role: 'user' as const, parts: [{ text: 'earlier question' }] },
      { role: 'model' as const, parts: [{ text: 'earlier answer' }] },
    ];
    const agent = new AgentInteractive(createConfig({ chatHistory }), core);

    await agent.start(context);

    const messages = agent.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'info',
      content: 'History context from parent session included (2 messages)',
    });

    await agent.shutdown();
  });

  it('should not add info message when chatHistory is absent', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    await agent.start(context);

    expect(agent.getMessages()).toHaveLength(0);

    await agent.shutdown();
  });

  it('should pass undefined extraHistory when chatHistory is not set', async () => {
    const { core } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    await agent.start(context);

    expect(core.createChat).toHaveBeenCalledWith(context, {
      interactive: true,
      extraHistory: undefined,
    });

    await agent.shutdown();
  });

  // ─── Mid-Turn Queue Drain ───────────────────────────────────

  it('should pass midTurnDrain callback to runReasoningLoop', async () => {
    const { core } = createMockCore();

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _chat: unknown,
        _msgs: unknown,
        _tools: unknown,
        _abort: unknown,
        options?: ReasoningLoopOptions,
      ) => {
        expect(options?.midTurnDrain).toBeTypeOf('function');
        return { text: 'Done', terminateMode: null, turnsUsed: 1 };
      },
    );

    const config = createConfig({ initialTask: 'test' });
    const agent = new AgentInteractive(config, core);
    await agent.start(context);
    await vi.waitFor(() => expect(agent.getStatus()).toBe('idle'));

    const callArgs = (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(callArgs[4]).toHaveProperty('midTurnDrain');

    await agent.shutdown();
  });

  it('should drain queued messages mid-turn and record them', async () => {
    const { core } = createMockCore();

    let drainCallback: (() => string[]) | undefined;
    let resolveLoop: (() => void) | undefined;

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _chat: unknown,
        _msgs: unknown,
        _tools: unknown,
        _abort: unknown,
        options?: ReasoningLoopOptions,
      ) => {
        drainCallback = options?.midTurnDrain;
        await new Promise<void>((r) => {
          resolveLoop = r;
        });
        return { text: 'Done', terminateMode: null, turnsUsed: 1 };
      },
    );

    const config = createConfig();
    const agent = new AgentInteractive(config, core);
    await agent.start(context);

    // Start a message processing
    agent.enqueueMessage('primary task');
    await vi.waitFor(() => expect(agent.getStatus()).toBe('running'));

    // Enqueue another message while "running"
    agent.enqueueMessage('extra context');
    expect(agent.getQueueSize()).toBe(1);

    // Mid-turn drain should pick it up
    expect(drainCallback).toBeDefined();
    const drained = drainCallback!();
    expect(drained).toEqual(['extra context']);
    expect(agent.getQueueSize()).toBe(0);

    // Verify recorded as user message with metadata
    const messages = agent.getMessages();
    const midTurnMsg = messages.find(
      (m) =>
        m.role === 'user' &&
        m.content === 'extra context' &&
        m.metadata?.['midTurnInjected'] === true,
    );
    expect(midTurnMsg).toBeDefined();

    resolveLoop!();
    await vi.waitFor(() => expect(agent.getStatus()).toBe('idle'));
    await agent.shutdown();
  });

  it('should emit QUEUE_MESSAGES_CONSUMED event on drain', async () => {
    const { core, emitter } = createMockCore();

    let drainCallback: (() => string[]) | undefined;
    let resolveLoop: (() => void) | undefined;

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _chat: unknown,
        _msgs: unknown,
        _tools: unknown,
        _abort: unknown,
        options?: ReasoningLoopOptions,
      ) => {
        drainCallback = options?.midTurnDrain;
        await new Promise<void>((r) => {
          resolveLoop = r;
        });
        return { text: 'Done', terminateMode: null, turnsUsed: 1 };
      },
    );

    const config = createConfig();
    const agent = new AgentInteractive(config, core);
    await agent.start(context);

    agent.enqueueMessage('task');
    await vi.waitFor(() => expect(agent.getStatus()).toBe('running'));

    agent.enqueueMessage('update');

    const drainEvents: unknown[] = [];
    emitter.on(AgentEventType.QUEUE_MESSAGES_CONSUMED, (e: unknown) =>
      drainEvents.push(e),
    );

    drainCallback!();
    expect(drainEvents).toHaveLength(1);
    expect(drainEvents[0]).toMatchObject({
      messages: ['update'],
      count: 1,
    });

    resolveLoop!();
    await vi.waitFor(() => expect(agent.getStatus()).toBe('idle'));
    await agent.shutdown();
  });

  it('should not emit event when drain finds empty queue', async () => {
    const { core, emitter } = createMockCore();

    let drainCallback: (() => string[]) | undefined;

    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _chat: unknown,
        _msgs: unknown,
        _tools: unknown,
        _abort: unknown,
        options?: ReasoningLoopOptions,
      ) => {
        drainCallback = options?.midTurnDrain;
        return { text: 'Done', terminateMode: null, turnsUsed: 1 };
      },
    );

    const config = createConfig({ initialTask: 'test' });
    const agent = new AgentInteractive(config, core);
    await agent.start(context);
    await vi.waitFor(() => expect(agent.getStatus()).toBe('idle'));

    const drainEvents: unknown[] = [];
    emitter.on(AgentEventType.QUEUE_MESSAGES_CONSUMED, (e: unknown) =>
      drainEvents.push(e),
    );

    // Drain on empty queue
    const drained = drainCallback!();
    expect(drained).toEqual([]);
    expect(drainEvents).toHaveLength(0);

    await agent.shutdown();
  });

  // ─── Events ────────────────────────────────────────────────

  it('should emit status_change events', async () => {
    const { core, emitter } = createMockCore();
    const config = createConfig();
    const agent = new AgentInteractive(config, core);

    const statuses: AgentStatus[] = [];
    emitter.on(AgentEventType.STATUS_CHANGE, (payload) => {
      statuses.push(payload.newStatus);
    });

    await agent.start(context);
    await agent.shutdown();

    expect(statuses).toContain(AgentStatus.COMPLETED);
  });
});

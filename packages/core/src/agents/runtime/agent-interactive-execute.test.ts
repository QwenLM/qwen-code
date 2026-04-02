/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for AgentInteractive.execute() — multi-turn persistent loop.
 *
 * execute() accepts an initial prompt, runs one AgentCore turn, then
 * awaits the next message via sendMessage(). Session-level max_turns and
 * max_time_minutes are enforced across all turns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentInteractive } from './agent-interactive.js';
import type { AgentCore } from './agent-core.js';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import type { AgentTurnStartEvent, AgentTurnEndEvent } from './agent-events.js';
import { ContextState } from './agent-headless.js';
import type { AgentInteractiveConfig } from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';

// ─── Test helpers ────────────────────────────────────────────

function createMockChat() {
  return { sendMessageStream: vi.fn() };
}

function createMockCore(
  overrides: {
    nullChat?: boolean;
    loopResult?: {
      text: string;
      terminateMode: string | null;
      turnsUsed: number;
    };
  } = {},
) {
  const emitter = new AgentEventEmitter();
  const chatReturnValue = overrides.nullChat ? undefined : createMockChat();

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

// ─── Tests ────────────────────────────────────────────────────

describe('AgentInteractive.execute() — multi-turn loop', () => {
  let context: ContextState;

  beforeEach(() => {
    context = new ContextState();
  });

  // ── Normal multi-turn ─────────────────────────────────────

  it('should process the initial prompt and accumulate message history', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    // Run first turn, then abort to end session without waiting forever.
    const executePromise = agent.execute('Hello', context);

    // Give the first turn time to run.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(1);
    });

    // Abort to unblock execute().
    agent.abort();

    const result = await executePromise;

    expect(result.messageHistory.length).toBeGreaterThan(0);
    expect(result.messageHistory[0]?.role).toBe('user');
    expect(result.messageHistory[0]?.content).toBe('Hello');
  });

  it('should complete two full turns when sendMessage is called after turn 1', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    const executePromise = agent.execute('Turn 1', context);

    // Wait for turn 1 to complete (runReasoningLoop called once).
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });

    // Inject turn 2 message.
    agent.sendMessage('Turn 2');

    // Wait for turn 2 to complete (runReasoningLoop called twice).
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(2);
    });

    // Abort to end the session.
    agent.abort();

    const result = await executePromise;

    // Both user messages should be in history.
    const userMessages = result.messageHistory.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.content).toBe('Turn 1');
    expect(userMessages[1]?.content).toBe('Turn 2');
  });

  // ── max_turns session limit ────────────────────────────────

  it('should terminate with MAX_TURNS after the session turn limit is reached', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    // Start execute with maxTurns=2.
    // It will run turn 0, then turn 1, then check limit and stop.
    const executePromise = agent.execute('Turn 1', context, 2);

    // Turn 1 runs automatically.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });

    // Inject turn 2.
    agent.sendMessage('Turn 2');

    // Wait for turn 2 to finish.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(2);
    });

    // After 2 turns the limit is reached — execute() should resolve on its own.
    const result = await executePromise;

    expect(result.terminateMode).toBe(AgentTerminateMode.MAX_TURNS);
    // Both turns completed.
    expect(
      (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(2);
  });

  it('should not start turn 1 when max_turns=0', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    const result = await agent.execute('Hello', context, 0);

    // With limit=0, no turns should run.
    expect(
      (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
    expect(result.terminateMode).toBe(AgentTerminateMode.MAX_TURNS);
  });

  // ── max_time_minutes timeout ───────────────────────────────

  it('should terminate with TIMEOUT when elapsed time exceeds the limit', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    // Use maxTimeMinutes=0 so any non-zero elapsed time triggers timeout.
    // The check runs AFTER the first turn completes (post-turn limit check),
    // so runReasoningLoop is called once before the session ends.
    const result = await agent.execute(
      'Hello',
      context,
      undefined, // no turn limit
      0, // 0 minutes → times out after the first turn
    );

    // One turn ran before the timeout triggered.
    expect(
      (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
    expect(result.terminateMode).toBe(AgentTerminateMode.TIMEOUT);
  });

  // ── sendMessage buffering ──────────────────────────────────

  it('should buffer a message sent before execute() reaches its wait point', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    // Pre-queue turn 2 before turn 1 even completes.
    // execute() hasn't been called yet, so sendMessage buffers.
    agent.sendMessage('Pre-queued turn 2');

    const executePromise = agent.execute('Turn 1', context, 2);

    // Both turns should complete automatically.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(2);
    });

    const result = await executePromise;

    expect(result.terminateMode).toBe(AgentTerminateMode.MAX_TURNS);
    const userMessages = result.messageHistory.filter((m) => m.role === 'user');
    expect(userMessages[0]?.content).toBe('Turn 1');
    expect(userMessages[1]?.content).toBe('Pre-queued turn 2');
  });

  // ── TURN_START / TURN_END events ───────────────────────────

  it('should emit TURN_START and TURN_END for each turn', async () => {
    const { core, emitter } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    const turnStartEvents: AgentTurnStartEvent[] = [];
    const turnEndEvents: AgentTurnEndEvent[] = [];

    emitter.on(AgentEventType.TURN_START, (e) => turnStartEvents.push(e));
    emitter.on(AgentEventType.TURN_END, (e) => turnEndEvents.push(e));

    const executePromise = agent.execute('First turn', context, 1);

    const result = await executePromise;

    expect(result.terminateMode).toBe(AgentTerminateMode.MAX_TURNS);
    expect(turnStartEvents).toHaveLength(1);
    expect(turnEndEvents).toHaveLength(1);
    expect(turnStartEvents[0]?.turn).toBe(0);
    expect(turnStartEvents[0]?.prompt).toBe('First turn');
    expect(turnEndEvents[0]?.turn).toBe(0);
    expect(turnEndEvents[0]?.terminateMode).toBeNull();
  });

  it('should emit TURN_START/TURN_END for each of multiple turns', async () => {
    const { core, emitter } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    const turnStartEvents: AgentTurnStartEvent[] = [];
    const turnEndEvents: AgentTurnEndEvent[] = [];

    emitter.on(AgentEventType.TURN_START, (e) => turnStartEvents.push(e));
    emitter.on(AgentEventType.TURN_END, (e) => turnEndEvents.push(e));

    const executePromise = agent.execute('First', context, 2);

    // Turn 1 runs, then wait for turn 2.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });

    agent.sendMessage('Second');

    const result = await executePromise;

    expect(result.terminateMode).toBe(AgentTerminateMode.MAX_TURNS);
    expect(turnStartEvents).toHaveLength(2);
    expect(turnEndEvents).toHaveLength(2);
    expect(turnStartEvents[0]?.turn).toBe(0);
    expect(turnStartEvents[1]?.turn).toBe(1);
    expect(turnEndEvents[0]?.turn).toBe(0);
    expect(turnEndEvents[1]?.turn).toBe(1);
  });

  // ── Chat creation failure ──────────────────────────────────

  it('should return ERROR terminateMode when chat creation fails', async () => {
    const { core } = createMockCore({ nullChat: true });
    const agent = new AgentInteractive(createConfig(), core);

    const result = await agent.execute('Hello', context);

    expect(result.terminateMode).toBe(AgentTerminateMode.ERROR);
  });

  // ── Abort during execute() ─────────────────────────────────

  it('should terminate with CANCELLED when abort() is called mid-session', async () => {
    const { core } = createMockCore();
    let resolveLoop!: (v: unknown) => void;
    (core.runReasoningLoop as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLoop = resolve;
        }),
    );

    const agent = new AgentInteractive(createConfig(), core);
    const executePromise = agent.execute('Task', context);

    // Wait for turn to start.
    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });

    agent.abort();
    resolveLoop({ text: '', terminateMode: 'cancelled', turnsUsed: 0 });

    const result = await executePromise;
    expect(result.terminateMode).toBe(AgentTerminateMode.CANCELLED);
  });

  // ── AgentHeadless regression guard ────────────────────────

  it('should leave AgentHeadless behavior unaffected (enqueueMessage still works)', async () => {
    const { core } = createMockCore();
    const agent = new AgentInteractive(createConfig(), core);

    await agent.start(context);
    agent.enqueueMessage('via queue');

    await vi.waitFor(() => {
      expect(
        (core.runReasoningLoop as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });

    await agent.shutdown();
    expect(agent.getStatus()).toBe('completed');
  });
});

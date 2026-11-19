/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { FakeAgent, type FakeAgentScript } from './fake-agent.js';
import { AgentStatus } from '../../runtime/agent-types.js';
import { AgentEventType } from '../../runtime/agent-events.js';
import type { AgentStatusChangeEvent } from '../../runtime/agent-events.js';

describe('FakeAgent', () => {
  const create = (script?: FakeAgentScript) =>
    new FakeAgent('a1', 'Agent 1', script);

  async function started(script?: FakeAgentScript): Promise<FakeAgent> {
    const agent = create(script);
    await agent.start();
    return agent;
  }

  function statusEvents(agent: FakeAgent): AgentStatusChangeEvent[] {
    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));
    return events;
  }

  const stayRunning = () => started({ onMessage: () => 'stay_running' });

  it('starts in INITIALIZING status', () => {
    expect(create().getStatus()).toBe(AgentStatus.INITIALIZING);
  });

  it('transitions to IDLE after start()', async () => {
    const agent = await started();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('calls onStart script during start()', async () => {
    const onStart = vi.fn();
    const agent = await started({ onStart });
    expect(onStart).toHaveBeenCalledWith(agent);
  });

  it('handles async onStart script', async () => {
    let resolved = false;
    const agent = await started({
      onStart: async () => {
        await Promise.resolve();
        resolved = true;
      },
    });
    expect(resolved).toBe(true);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('preserves status if onStart sets it', async () => {
    const agent = await started({
      onStart: (a) => a.setStatus(AgentStatus.RUNNING),
    });
    // onStart set RUNNING; start() only sets IDLE if still INIT
    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);
  });

  it('records messages via enqueueMessage', async () => {
    const agent = await started();
    agent.enqueueMessage('hello');
    agent.enqueueMessage('world');
    expect(agent.getReceivedMessages()).toEqual(['hello', 'world']);
  });

  it('transitions RUNNING → IDLE on enqueueMessage (default)', async () => {
    const agent = await started();
    const events = statusEvents(agent);

    agent.enqueueMessage('test');

    // Should have gone IDLE → RUNNING → IDLE
    expect(events).toHaveLength(2);
    expect(events[0]!.newStatus).toBe(AgentStatus.RUNNING);
    expect(events[1]!.newStatus).toBe(AgentStatus.IDLE);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('calls onMessage script with message and agent', async () => {
    const onMessage = vi.fn();
    const agent = await started({ onMessage });
    agent.enqueueMessage('payload');
    expect(onMessage).toHaveBeenCalledWith('payload', agent);
  });

  it('stays RUNNING when onMessage returns stay_running', async () => {
    const agent = await stayRunning();
    agent.enqueueMessage('hold');
    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);

    // Manual idle
    agent.goIdle();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('stays RUNNING then goes IDLE when onMessage returns Promise', async () => {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((r) => {
      resolvePromise = r;
    });
    const agent = await started({ onMessage: () => promise });

    agent.enqueueMessage('async work');
    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);

    resolvePromise();
    await promise;
    // Give microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('emits STATUS_CHANGE events', async () => {
    const agent = create();
    const events = statusEvents(agent);

    await agent.start();

    expect(events).toHaveLength(1);
    expect(events[0]!.previousStatus).toBe(AgentStatus.INITIALIZING);
    expect(events[0]!.newStatus).toBe(AgentStatus.IDLE);
    expect(events[0]!.agentId).toBe('a1');
  });

  // Each action runs on a started (IDLE) agent and must emit nothing.
  it.each([
    [
      'does not emit when status is unchanged',
      (a: FakeAgent) => a.setStatus(AgentStatus.IDLE), // same as current
    ],
    ['goIdle is a no-op if not RUNNING', (a: FakeAgent) => a.goIdle()],
    [
      'cancelCurrentRound is a no-op if not RUNNING',
      (a: FakeAgent) => a.cancelCurrentRound(),
    ],
  ])('%s', async (_title, act) => {
    const agent = await started();
    const events = statusEvents(agent);
    act(agent);
    expect(events).toHaveLength(0);
  });

  it('goIdle transitions RUNNING → IDLE', async () => {
    const agent = await stayRunning();
    agent.enqueueMessage('work');

    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);
    agent.goIdle();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('abort sets status to CANCELLED', async () => {
    const agent = await started();
    agent.abort();
    expect(agent.getStatus()).toBe(AgentStatus.CANCELLED);
  });

  it('shutdown sets status to COMPLETED', async () => {
    const agent = await started();
    await agent.shutdown();
    expect(agent.getStatus()).toBe(AgentStatus.COMPLETED);
  });

  it('shutdown preserves terminal status', async () => {
    const agent = await started();
    agent.setStatus(AgentStatus.FAILED);
    await agent.shutdown();
    expect(agent.getStatus()).toBe(AgentStatus.FAILED);
  });

  it('cancelCurrentRound transitions RUNNING → IDLE', async () => {
    const agent = await stayRunning();
    agent.enqueueMessage('work');

    agent.cancelCurrentRound();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('waitForCompletion resolves on terminal status', async () => {
    const agent = await started();

    let completed = false;
    const p = agent.waitForCompletion().then(() => {
      completed = true;
    });

    expect(completed).toBe(false);
    agent.setStatus(AgentStatus.COMPLETED);
    await p;
    expect(completed).toBe(true);
  });

  it('waitForCompletion resolves immediately if already terminal', async () => {
    const agent = await started();
    agent.abort();

    await agent.waitForCompletion(); // should not hang
    expect(agent.getStatus()).toBe(AgentStatus.CANCELLED);
  });

  it('waitForMessageCount resolves immediately if count met', async () => {
    const agent = await started();
    agent.enqueueMessage('one');
    agent.enqueueMessage('two');

    await agent.waitForMessageCount(2); // should not hang
    expect(agent.getReceivedMessages()).toHaveLength(2);
  });

  it('waitForMessageCount waits for future messages', async () => {
    const agent = await started();

    let resolved = false;
    const p = agent.waitForMessageCount(2).then(() => {
      resolved = true;
    });

    agent.enqueueMessage('one');
    expect(resolved).toBe(false);

    agent.enqueueMessage('two');
    await p;
    expect(resolved).toBe(true);
  });

  it('waitForStatus resolves immediately if already in target', async () => {
    const agent = await started();
    await agent.waitForStatus(AgentStatus.IDLE);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('waitForStatus waits for future transition', async () => {
    const agent = await started();

    let resolved = false;
    const p = agent.waitForStatus(AgentStatus.COMPLETED).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await agent.shutdown();
    await p;
    expect(resolved).toBe(true);
  });

  it('returns stub stats', () => {
    const stats = create().getStats();
    expect(stats.rounds).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.toolUsage).toEqual([]);
  });

  it('error accessors return undefined by default', () => {
    const agent = create();
    expect(agent.getError()).toBeUndefined();
    expect(agent.getLastRoundError()).toBeUndefined();
  });

  it('setError / setLastRoundError update values', () => {
    const agent = create();
    agent.setError('boom');
    agent.setLastRoundError('round boom');
    expect(agent.getError()).toBe('boom');
    expect(agent.getLastRoundError()).toBe('round boom');
  });
});

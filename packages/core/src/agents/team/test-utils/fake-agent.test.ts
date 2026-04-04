/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { FakeAgent } from './fake-agent.js';
import { AgentStatus } from '../../runtime/agent-types.js';
import { AgentEventType } from '../../runtime/agent-events.js';
import type { AgentStatusChangeEvent } from '../../runtime/agent-events.js';

describe('FakeAgent', () => {
  // ─── Construction & start ────────────────────────────────────

  it('starts in INITIALIZING status', () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    expect(agent.getStatus()).toBe(AgentStatus.INITIALIZING);
  });

  it('transitions to IDLE after start()', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('calls onStart script during start()', async () => {
    const onStart = vi.fn();
    const agent = new FakeAgent('a1', 'Agent 1', { onStart });
    await agent.start();
    expect(onStart).toHaveBeenCalledWith(agent);
  });

  it('handles async onStart script', async () => {
    let resolved = false;
    const agent = new FakeAgent('a1', 'Agent 1', {
      onStart: async () => {
        await Promise.resolve();
        resolved = true;
      },
    });
    await agent.start();
    expect(resolved).toBe(true);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('preserves status if onStart sets it', async () => {
    const agent = new FakeAgent('a1', 'Agent 1', {
      onStart: (a) => a.setStatus(AgentStatus.RUNNING),
    });
    await agent.start();
    // onStart set RUNNING; start() only sets IDLE if still INIT
    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);
  });

  // ─── enqueueMessage ──────────────────────────────────────────

  it('records messages via enqueueMessage', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    agent.enqueueMessage('hello');
    agent.enqueueMessage('world');

    expect(agent.getReceivedMessages()).toEqual(['hello', 'world']);
  });

  it('transitions RUNNING → IDLE on enqueueMessage (default)', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));

    agent.enqueueMessage('test');

    // Should have gone IDLE → RUNNING → IDLE
    expect(events).toHaveLength(2);
    expect(events[0]!.newStatus).toBe(AgentStatus.RUNNING);
    expect(events[1]!.newStatus).toBe(AgentStatus.IDLE);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('calls onMessage script with message and agent', async () => {
    const onMessage = vi.fn();
    const agent = new FakeAgent('a1', 'Agent 1', { onMessage });
    await agent.start();

    agent.enqueueMessage('payload');

    expect(onMessage).toHaveBeenCalledWith('payload', agent);
  });

  it('stays RUNNING when onMessage returns stay_running', async () => {
    const agent = new FakeAgent('a1', 'Agent 1', {
      onMessage: () => 'stay_running',
    });
    await agent.start();

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

    const agent = new FakeAgent('a1', 'Agent 1', {
      onMessage: () => promise,
    });
    await agent.start();

    agent.enqueueMessage('async work');
    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);

    resolvePromise();
    await promise;
    // Give microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  // ─── Status transitions ──────────────────────────────────────

  it('emits STATUS_CHANGE events', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));

    await agent.start();

    expect(events).toHaveLength(1);
    expect(events[0]!.previousStatus).toBe(AgentStatus.INITIALIZING);
    expect(events[0]!.newStatus).toBe(AgentStatus.IDLE);
    expect(events[0]!.agentId).toBe('a1');
  });

  it('does not emit when status is unchanged', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));

    agent.setStatus(AgentStatus.IDLE); // same as current
    expect(events).toHaveLength(0);
  });

  // ─── goIdle ──────────────────────────────────────────────────

  it('goIdle transitions RUNNING → IDLE', async () => {
    const agent = new FakeAgent('a1', 'Agent 1', {
      onMessage: () => 'stay_running',
    });
    await agent.start();
    agent.enqueueMessage('work');

    expect(agent.getStatus()).toBe(AgentStatus.RUNNING);
    agent.goIdle();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('goIdle is a no-op if not RUNNING', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));

    agent.goIdle(); // already IDLE
    expect(events).toHaveLength(0);
  });

  // ─── abort / shutdown / cancelCurrentRound ───────────────────

  it('abort sets status to CANCELLED', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();
    agent.abort();
    expect(agent.getStatus()).toBe(AgentStatus.CANCELLED);
  });

  it('shutdown sets status to COMPLETED', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();
    await agent.shutdown();
    expect(agent.getStatus()).toBe(AgentStatus.COMPLETED);
  });

  it('shutdown preserves terminal status', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();
    agent.setStatus(AgentStatus.FAILED);
    await agent.shutdown();
    expect(agent.getStatus()).toBe(AgentStatus.FAILED);
  });

  it('cancelCurrentRound transitions RUNNING → IDLE', async () => {
    const agent = new FakeAgent('a1', 'Agent 1', {
      onMessage: () => 'stay_running',
    });
    await agent.start();
    agent.enqueueMessage('work');

    agent.cancelCurrentRound();
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('cancelCurrentRound is a no-op if not RUNNING', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    const events: AgentStatusChangeEvent[] = [];
    agent
      .getEventEmitter()
      .on(AgentEventType.STATUS_CHANGE, (e) => events.push(e));

    agent.cancelCurrentRound();
    expect(events).toHaveLength(0);
  });

  // ─── waitForCompletion ───────────────────────────────────────

  it('waitForCompletion resolves on terminal status', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

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
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();
    agent.abort();

    await agent.waitForCompletion(); // should not hang
    expect(agent.getStatus()).toBe(AgentStatus.CANCELLED);
  });

  // ─── waitForMessageCount ─────────────────────────────────────

  it('waitForMessageCount resolves immediately if count met', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    agent.enqueueMessage('one');
    agent.enqueueMessage('two');

    await agent.waitForMessageCount(2); // should not hang
    expect(agent.getReceivedMessages()).toHaveLength(2);
  });

  it('waitForMessageCount waits for future messages', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

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

  // ─── waitForStatus ───────────────────────────────────────────

  it('waitForStatus resolves immediately if already in target', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    await agent.waitForStatus(AgentStatus.IDLE);
    expect(agent.getStatus()).toBe(AgentStatus.IDLE);
  });

  it('waitForStatus waits for future transition', async () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    await agent.start();

    let resolved = false;
    const p = agent.waitForStatus(AgentStatus.COMPLETED).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(false);
    await agent.shutdown();
    await p;
    expect(resolved).toBe(true);
  });

  // ─── getStats ────────────────────────────────────────────────

  it('returns stub stats', () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    const stats = agent.getStats();

    expect(stats.rounds).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.toolUsage).toEqual([]);
  });

  // ─── Error accessors ────────────────────────────────────────

  it('error accessors return undefined by default', () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    expect(agent.getError()).toBeUndefined();
    expect(agent.getLastRoundError()).toBeUndefined();
  });

  it('setError / setLastRoundError update values', () => {
    const agent = new FakeAgent('a1', 'Agent 1');
    agent.setError('boom');
    agent.setLastRoundError('round boom');
    expect(agent.getError()).toBe('boom');
    expect(agent.getLastRoundError()).toBe('round boom');
  });
});

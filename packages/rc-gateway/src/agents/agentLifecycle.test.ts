/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from './agentRegistry.js';
import { AgentLifecycle } from './agentLifecycle.js';
import { OwnerEventBus, type OwnerEvent } from '../ownerEvents.js';
import {
  PromptEventBroadcaster,
  type GatewayEvent,
} from '../routes/promptEventBroadcaster.js';

async function setup(costFor?: (sid: string) => number | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'lifecycle-'));
  const registry = await AgentRegistry.open(join(dir, 'agents.json'));
  const ownerEvents = new OwnerEventBus();
  const ownerSeen: OwnerEvent[] = [];
  ownerEvents.subscribe((e) => ownerSeen.push(e));
  const promptEvents = new PromptEventBroadcaster();
  const notified: Array<{ type: string; sessionId: string }> = [];
  const notifier = {
    notify: async (
      ev: { type: string; data: unknown },
      ctx: { sessionId: string },
    ) => {
      notified.push({ type: ev.type, sessionId: ctx.sessionId });
    },
  };
  const lifecycle = new AgentLifecycle(
    registry,
    ownerEvents,
    promptEvents,
    notifier,
    costFor,
  );
  return { registry, lifecycle, ownerSeen, promptEvents, notified };
}

describe('AgentLifecycle', () => {
  it('session_died marks failed and emits agent_failed everywhere', async () => {
    const { registry, lifecycle, ownerSeen, promptEvents, notified } =
      await setup(() => 1234);
    const parentSeen: GatewayEvent[] = [];
    promptEvents.register('parent-1', (e) => parentSeen.push(e));
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: 'parent-1',
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });

    await lifecycle.handleSessionEvent('s1', {
      type: 'session_died',
      data: { reason: 'crashed' },
    });

    expect(registry.get(rec.agentId)?.status).toBe('failed');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_failed');
    expect(parentSeen.map((e) => e.type)).toContain('agent_failed');
    expect(notified.map((n) => n.type)).toContain('agent_failed');
    const frame = ownerSeen.find((e) => e.type === 'agent_failed') as Extract<
      OwnerEvent,
      { type: 'agent_failed' }
    >;
    expect(frame.agent.costMicrocents).toBe(1234);
  });

  it('permission_request blocks; a later session_update resumes without a frame', async () => {
    const { registry, lifecycle, ownerSeen } = await setup();
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });

    await lifecycle.handleSessionEvent('s1', {
      type: 'permission_request',
      data: { requestId: 'r1' },
    });
    expect(registry.get(rec.agentId)?.status).toBe('blocked');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_blocked');

    const framesBefore = ownerSeen.length;
    await lifecycle.handleSessionEvent('s1', {
      type: 'session_update',
      data: { text: 'tool ran' },
    });
    expect(registry.get(rec.agentId)?.status).toBe('running');
    // Resumption emits NO dedicated frame (spec: only the five events).
    expect(ownerSeen.length).toBe(framesBefore);
  });

  it('onPromptSettled completes the agent; a cancelled agent never re-transitions', async () => {
    const { registry, lifecycle, ownerSeen } = await setup();
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      spawnedByTokenId: 'tkn1',
    });
    await lifecycle.onPromptSettled(rec.agentId, 'completed');
    expect(registry.get(rec.agentId)?.status).toBe('completed');
    expect(ownerSeen.map((e) => e.type)).toContain('agent_completed');

    // Terminal: a late session_died must emit nothing new.
    const before = ownerSeen.length;
    await lifecycle.handleSessionEvent('s1', {
      type: 'session_died',
      data: {},
    });
    expect(ownerSeen.length).toBe(before);
    expect(registry.get(rec.agentId)?.status).toBe('completed');
  });

  it('ignores events for sessions that back no agent', async () => {
    const { lifecycle, ownerSeen } = await setup();
    await lifecycle.handleSessionEvent('not-an-agent', {
      type: 'session_died',
      data: {},
    });
    expect(ownerSeen).toHaveLength(0);
  });

  it('owner-stream frame never carries the agent task text; the parent stream still does', async () => {
    const SECRET_TASK = 'SECRET_SPAWN_PROMPT_MARKER: ' + 'x'.repeat(1900);
    const { registry, lifecycle, ownerSeen, promptEvents } = await setup();
    const parentSeen: GatewayEvent[] = [];
    promptEvents.register('parent-1', (e) => parentSeen.push(e));
    const rec = await registry.register({
      sessionId: 's1',
      parentSessionId: 'parent-1',
      agentType: 'general',
      task: SECRET_TASK,
      spawnedByTokenId: 'tkn1',
    });

    await lifecycle.handleSessionEvent('s1', {
      type: 'session_died',
      data: {},
    });

    const frame = ownerSeen.find((e) => e.type === 'agent_failed') as Extract<
      OwnerEvent,
      { type: 'agent_failed' }
    >;
    expect(frame).toBeDefined();
    expect(JSON.stringify(frame)).not.toContain('SECRET_SPAWN_PROMPT_MARKER');
    expect(frame.agent).not.toHaveProperty('task');
    // Only ids/enums/counts survive on the owner stream.
    expect(frame.agent).toMatchObject({
      agentId: rec.agentId,
      sessionId: 's1',
      parentSessionId: 'parent-1',
      agentType: 'general',
      status: 'failed',
    });

    // The parent session's own stream already knows the task it spawned with
    // (it's the parent's own prompt content) — that surface is UNCHANGED.
    const parentFrame = parentSeen.find((e) => e.type === 'agent_failed');
    expect(JSON.stringify(parentFrame)).toContain('SECRET_SPAWN_PROMPT_MARKER');
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { AuditRecord } from './auditLog.js';
import {
  OwnerEventBus,
  MAX_OWNER_SUBSCRIBERS,
  type OwnerEvent,
} from './ownerEvents.js';

function auditEvent(action: string): OwnerEvent {
  return {
    type: 'audit',
    record: { ts: 1, action } as unknown as AuditRecord,
  };
}

describe('OwnerEventBus', () => {
  it('delivers a published event to a subscriber', () => {
    const bus = new OwnerEventBus();
    const got: OwnerEvent[] = [];
    bus.subscribe((e) => got.push(e));
    bus.publish(auditEvent('token_minted'));
    expect(got).toHaveLength(1);
    expect(got[0].record.action).toBe('token_minted');
  });

  it('fans out to every subscriber', () => {
    const bus = new OwnerEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe(() => a++);
    bus.subscribe(() => b++);
    bus.publish(auditEvent('prompt_sent'));
    expect([a, b]).toEqual([1, 1]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new OwnerEventBus();
    const got: OwnerEvent[] = [];
    const unsub = bus.subscribe((e) => got.push(e));
    expect(unsub).not.toBeNull();
    unsub!();
    bus.publish(auditEvent('token_revoked'));
    expect(got).toHaveLength(0);
    expect(bus.size).toBe(0);
  });

  it('isolates a throwing subscriber from the others and the publisher', () => {
    const bus = new OwnerEventBus();
    let reached = 0;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => reached++);
    expect(() => bus.publish(auditEvent('auth_failed'))).not.toThrow();
    expect(reached).toBe(1);
  });

  it('tracks size and caps subscribers, returning null at capacity', () => {
    const bus = new OwnerEventBus();
    const unsubs: Array<() => void> = [];
    for (let i = 0; i < MAX_OWNER_SUBSCRIBERS; i++) {
      const u = bus.subscribe(() => {});
      expect(u).not.toBeNull();
      unsubs.push(u!);
    }
    expect(bus.size).toBe(MAX_OWNER_SUBSCRIBERS);
    expect(bus.subscribe(() => {})).toBeNull();
    // Freeing one slot lets a new subscriber in.
    unsubs[0]();
    expect(bus.subscribe(() => {})).not.toBeNull();
  });
});

describe('agent + hook OwnerEvent variants', () => {
  it('fans agent lifecycle and hook_event frames to subscribers', () => {
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const agent = {
      agentId: 'a1',
      sessionId: 's1',
      parentSessionId: null,
      agentType: 'general',
      task: 't',
      status: 'running',
    };
    bus.publish({ type: 'agent_spawned', agent });
    bus.publish({
      type: 'hook_event',
      event: 'PreToolUse',
      sessionId: 's1',
      toolName: 'Bash',
      payload: { command: 'ls' },
      dropped: 2,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: 'agent_spawned' });
    expect(seen[1]).toMatchObject({ type: 'hook_event', dropped: 2 });
  });

  it('publishes a review lifecycle event to subscribers', () => {
    const bus = new OwnerEventBus();
    const seen: OwnerEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.publish({
      type: 'review_started',
      review: {
        reviewId: 'r1',
        sessionId: 's1',
        target: { kind: 'local' },
        status: 'running',
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'review_started' });
  });
});

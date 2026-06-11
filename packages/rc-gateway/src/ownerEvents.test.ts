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

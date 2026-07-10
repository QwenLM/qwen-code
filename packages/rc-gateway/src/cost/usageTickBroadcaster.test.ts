/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { UsageTickBroadcaster } from './usageTickBroadcaster.js';
import type { UsageTick } from './ingester.js';

const tick = (sessionId: string, total = 1): UsageTick => ({
  sessionId,
  costMicrocentsSesTotal: total,
  costMicrocentsPromptTotal: total,
  tokensInTotal: 0,
  tokensOutTotal: 0,
});

describe('UsageTickBroadcaster', () => {
  it('fans a tick to every registered writer for the session', () => {
    const b = new UsageTickBroadcaster();
    const a: UsageTick[] = [];
    const c: UsageTick[] = [];
    b.register('s1', (t) => a.push(t));
    b.register('s1', (t) => c.push(t));
    b.emit(tick('s1', 5));
    expect(a).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(a[0].costMicrocentsSesTotal).toBe(5);
  });

  it('does not deliver to other sessions', () => {
    const b = new UsageTickBroadcaster();
    const got: UsageTick[] = [];
    b.register('s1', (t) => got.push(t));
    b.emit(tick('s2'));
    expect(got).toHaveLength(0);
  });

  it('stops delivering after unregister and cleans up the session set', () => {
    const b = new UsageTickBroadcaster();
    const got: UsageTick[] = [];
    const off = b.register('s1', (t) => got.push(t));
    off();
    expect(b.listenerCount('s1')).toBe(0);
    b.emit(tick('s1'));
    expect(got).toHaveLength(0);
  });

  it('emit to a session with no listeners is a no-op', () => {
    const b = new UsageTickBroadcaster();
    expect(() => b.emit(tick('nobody'))).not.toThrow();
  });

  it('a throwing listener does not break sibling listeners', () => {
    const b = new UsageTickBroadcaster();
    const got: UsageTick[] = [];
    b.register('s1', () => {
      throw new Error('wedged relay');
    });
    b.register('s1', (t) => got.push(t));
    expect(() => b.emit(tick('s1'))).not.toThrow();
    expect(got).toHaveLength(1); // sibling still received it
  });
});

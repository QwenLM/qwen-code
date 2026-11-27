/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  createDenialTracker,
  DEFAULT_DENIAL_LIMITS,
} from './denial-tracking.js';

describe('createDenialTracker', () => {
  it('trips on the consecutive limit and names it', () => {
    const tracker = createDenialTracker({
      maxConsecutive: 3,
      maxTotal: 20,
    });
    tracker.recordDenial();
    tracker.recordDenial();
    expect(tracker.checkCircuitBreaker().tripped).toBe(false);

    tracker.recordDenial();
    const breaker = tracker.checkCircuitBreaker();
    expect(breaker).toMatchObject({ tripped: true, reason: 'maxConsecutive' });
  });

  it('trips on the session total even when no streak ever forms', () => {
    const tracker = createDenialTracker({
      maxConsecutive: 3,
      maxTotal: 4,
    });
    for (let i = 0; i < 4; i++) {
      tracker.recordDenial();
      tracker.recordAllow();
    }
    expect(tracker.getCounters().consecutiveDenials).toBe(0);
    expect(tracker.checkCircuitBreaker()).toMatchObject({
      tripped: true,
      reason: 'maxTotal',
    });
  });

  it('resets only the streak on an allow, so the session total stands', () => {
    const tracker = createDenialTracker();
    tracker.recordDenial();
    tracker.recordAllow();
    expect(tracker.getCounters()).toEqual({
      consecutiveDenials: 0,
      totalDenials: 1,
    });
  });

  it('clears both counters on reset', () => {
    const tracker = createDenialTracker();
    tracker.recordDenial();
    tracker.recordDenial();
    tracker.reset();
    expect(tracker.getCounters()).toEqual({
      consecutiveDenials: 0,
      totalDenials: 0,
    });
    expect(tracker.checkCircuitBreaker().tripped).toBe(false);
  });

  it('hands back a copy of the counters, so a caller cannot mutate them', () => {
    const tracker = createDenialTracker();
    tracker.recordDenial();
    const snapshot = tracker.getCounters();
    tracker.recordDenial();
    expect(snapshot.totalDenials).toBe(1);
    expect(tracker.getCounters().totalDenials).toBe(2);
  });

  it('defaults to the documented limits', () => {
    expect(DEFAULT_DENIAL_LIMITS).toEqual({
      maxConsecutive: 3,
      maxTotal: 20,
    });
    const tracker = createDenialTracker();
    for (let i = 0; i < DEFAULT_DENIAL_LIMITS.maxConsecutive; i++) {
      tracker.recordDenial();
    }
    expect(tracker.checkCircuitBreaker().tripped).toBe(true);
  });
});

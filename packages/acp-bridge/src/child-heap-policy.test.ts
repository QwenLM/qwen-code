/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createChildHeapPolicy } from './child-heap-policy.js';
import {
  MIN_CHILD_HEAP_MB,
  resolveDaemonMemoryBudget,
} from './daemon-memory-budget.js';

// 8 GB of available memory, so the derived pool is a realistic size and the
// refusal boundary lands at a child count a real daemon could reach.
const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
const poolMb = budget.childPoolMb;
// The last count the pool can still cover at the floor, and the first it cannot.
const lastFitting = Math.floor(poolMb / MIN_CHILD_HEAP_MB);

describe('createChildHeapPolicy', () => {
  it('refuses exactly when the pool can no longer cover another child', () => {
    const policy = createChildHeapPolicy({ budget, mode: 'enforce' });

    expect(policy.decide(lastFitting).refuse).toBe(false);
    expect(policy.decide(lastFitting + 1).refuse).toBe(true);

    // The boundary is the unclamped quotient, not the returned share. Past
    // the boundary the share saturates at the floor and stops carrying any
    // information: "barely does not fit" and "wildly does not fit" both read
    // as 512, so a refusal derived from the share could never tell them apart.
    expect(policy.decide(lastFitting).ceilingMb).toBeGreaterThan(
      MIN_CHILD_HEAP_MB,
    );
    expect(policy.decide(lastFitting + 1).ceilingMb).toBe(MIN_CHILD_HEAP_MB);
    expect(policy.decide(lastFitting * 4).ceilingMb).toBe(MIN_CHILD_HEAP_MB);
  });

  it('shrinks the share as children arrive, and never below the floor', () => {
    const policy = createChildHeapPolicy({ budget, mode: 'enforce' });

    const one = policy.decide(1).ceilingMb!;
    const two = policy.decide(2).ceilingMb!;
    const four = policy.decide(4).ceilingMb!;
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(four);
    expect(four).toBeGreaterThanOrEqual(MIN_CHILD_HEAP_MB);
    // Concurrency, not registration: this is a share of the pool at the count
    // passed in, so it is capped by the legacy ceiling rather than the pool.
    expect(one).toBeLessThanOrEqual(budget.legacyChildCeilingMb);
  });

  it('computes in observe mode but reports nothing as enforced', () => {
    const observe = createChildHeapPolicy({ budget, mode: 'observe' });

    // The point of `observe`: the numbers exist, so a caller can be wired up
    // and tested, while `enforced` stays false because nothing is applied.
    const decision = observe.decide(lastFitting + 1);
    expect(decision.ceilingMb).toBe(MIN_CHILD_HEAP_MB);
    expect(decision.refuse).toBe(true);
    expect(observe.snapshot()).toMatchObject({
      mode: 'observe',
      enforced: false,
      refusals: 1,
    });
  });

  it('counts would-be refusals so calibration does not need a broken deployment', () => {
    const policy = createChildHeapPolicy({ budget, mode: 'observe' });
    expect(policy.snapshot().refusals).toBe(0);

    policy.decide(1);
    policy.decide(lastFitting);
    expect(policy.snapshot().refusals).toBe(0);

    policy.decide(lastFitting + 1);
    policy.decide(lastFitting + 9);
    expect(policy.snapshot().refusals).toBe(2);
  });

  it('computes nothing at all when off', () => {
    const off = createChildHeapPolicy({ budget, mode: 'off' });

    // Not "a share of zero" — no share, so the caller keeps the historical
    // host-derived ceiling. And an off policy must never accrue refusals,
    // or the calibration counter would report on a daemon that never applied
    // the policy in the first place.
    expect(off.decide(lastFitting + 1)).toEqual({
      ceilingMb: undefined,
      refuse: false,
    });
    expect(off.snapshot()).toMatchObject({ enforced: false, refusals: 0 });
  });

  it('treats a zero or negative count as one child', () => {
    // Defensive: the caller reads a live count that should always include the
    // spawn being admitted, but a 0 would otherwise divide the pool by zero.
    const policy = createChildHeapPolicy({ budget, mode: 'enforce' });
    expect(policy.decide(0)).toEqual(policy.decide(1));
    expect(Number.isFinite(policy.decide(0).ceilingMb!)).toBe(true);
  });
});

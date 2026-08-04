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

describe('createChildHeapPolicy', () => {
  it.each([2_048, 8_192, 32_768, 262_144])(
    'keeps the sum of every admissible ceiling inside the pool (%i MB host)',
    (availableMemoryMb) => {
      // THE invariant. A per-spawn share bounds the child count but not the
      // memory — grants accumulate as P x H(n) because V8 cannot lower a
      // running child's ceiling — so this asserts the property that claim
      // actually needs: fill the daemon to its admission limit and the
      // authorised total still fits the pool.
      const b = resolveDaemonMemoryBudget({ availableMemoryMb });
      const policy = createChildHeapPolicy({ budget: b, mode: 'enforce' });
      const { maxConcurrentChildren, perChildCeilingMb } = policy.snapshot();

      let granted = 0;
      for (let n = 1; n <= maxConcurrentChildren; n++) {
        const decision = policy.decide(n);
        expect(decision.refuse).toBe(false);
        granted += decision.ceilingMb!;
      }
      expect(granted).toBeLessThanOrEqual(b.childPoolMb);
      expect(granted).toBe(maxConcurrentChildren * perChildCeilingMb);
      // And the child past the limit is refused, which is what holds the sum.
      expect(policy.decide(maxConcurrentChildren + 1).refuse).toBe(true);
    },
  );

  it('hands every child the same ceiling regardless of how many are live', () => {
    // The property the invariant rests on: a ceiling that shrank as children
    // arrived would leave the early, larger grants outstanding and unbounded.
    const b = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const policy = createChildHeapPolicy({ budget: b, mode: 'enforce' });
    const ceilings = [1, 2, 3, 7].map((n) => policy.decide(n).ceilingMb);
    expect(new Set(ceilings).size).toBe(1);
    expect(ceilings[0]).toBeGreaterThanOrEqual(MIN_CHILD_HEAP_MB);
  });

  it('sizes an 8 GB host for seven concurrent children', () => {
    // Pinned deliberately: this is the number an operator plans against, and
    // it is the cost of the invariant above — the eighth concurrent session
    // is refused even though real RSS would likely have fit it.
    const policy = createChildHeapPolicy({
      budget: resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 }),
      mode: 'enforce',
    });
    expect(policy.snapshot()).toMatchObject({
      childPoolMb: 3_687,
      maxConcurrentChildren: 7,
      perChildCeilingMb: 526,
    });
  });

  it('never admits more than the repository workspace maximum', () => {
    // A large host divides by MAX_DAEMON_WORKSPACES rather than by
    // pool/512, so the ceiling is 614 MB and not the 512 MB floor.
    const policy = createChildHeapPolicy({
      budget: resolveDaemonMemoryBudget({ availableMemoryMb: 32_768 }),
      mode: 'enforce',
    });
    expect(policy.snapshot()).toMatchObject({
      maxConcurrentChildren: 25,
      perChildCeilingMb: 614,
    });
  });

  it('computes in observe mode but reports nothing as enforced', () => {
    const b = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const observe = createChildHeapPolicy({ budget: b, mode: 'observe' });
    const over = observe.snapshot().maxConcurrentChildren + 1;

    const decision = observe.decide(over);
    expect(decision.ceilingMb).toBe(observe.snapshot().perChildCeilingMb);
    expect(decision.refuse).toBe(true);
    expect(observe.snapshot()).toMatchObject({
      mode: 'observe',
      enforced: false,
      refusals: 1,
    });
  });

  it('counts would-be refusals so calibration does not need a broken deployment', () => {
    const b = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const policy = createChildHeapPolicy({ budget: b, mode: 'observe' });
    const limit = policy.snapshot().maxConcurrentChildren;
    expect(policy.snapshot().refusals).toBe(0);

    policy.decide(1);
    policy.decide(limit);
    expect(policy.snapshot().refusals).toBe(0);

    policy.decide(limit + 1);
    policy.decide(limit + 9);
    expect(policy.snapshot().refusals).toBe(2);
  });

  it('computes nothing at all when off', () => {
    const b = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const off = createChildHeapPolicy({ budget: b, mode: 'off' });

    // Not "a share of zero" — no share, so the caller keeps the historical
    // host-derived ceiling. And an off policy must never accrue refusals.
    expect(off.decide(9_999)).toEqual({ ceilingMb: undefined, refuse: false });
    expect(off.snapshot()).toMatchObject({ enforced: false, refusals: 0 });
  });

  it('always admits at least one child, however small the pool', () => {
    // A pool below the floor would otherwise divide to zero and refuse every
    // spawn, bricking a daemon that works today.
    const tiny = createChildHeapPolicy({
      budget: resolveDaemonMemoryBudget({ availableMemoryMb: 1_024 }),
      mode: 'enforce',
    });
    expect(tiny.snapshot().maxConcurrentChildren).toBeGreaterThanOrEqual(1);
    expect(tiny.decide(1).refuse).toBe(false);
  });
});

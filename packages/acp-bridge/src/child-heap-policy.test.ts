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
    'models a partition whose total fits the pool (%i MB host)',
    (availableMemoryMb) => {
      // The invariant a per-spawn share could not hold: sizing each child by
      // the count live at *its* spawn accumulates grants as P x H(n), because
      // V8 cannot lower a running child's ceiling. A constant ceiling makes
      // the total n x ceiling, which admission keeps inside the pool.
      const b = resolveDaemonMemoryBudget({ availableMemoryMb });
      const { maxConcurrentChildren, perChildCeilingMb } =
        createChildHeapPolicy({ budget: b, mode: 'observe' }).snapshot();

      expect(maxConcurrentChildren).toBeGreaterThan(0);
      expect(perChildCeilingMb).toBeGreaterThanOrEqual(MIN_CHILD_HEAP_MB);
      expect(maxConcurrentChildren * perChildCeilingMb!).toBeLessThanOrEqual(
        b.childPoolMb,
      );
    },
  );

  it('admits no child when the pool cannot cover one, and offers no ceiling', () => {
    // A 512 MB host derives a 256 MB budget whose root reserve consumes all of
    // it, leaving a pool of 0. Clamping the count up to 1 here produced a
    // ceiling of 0 — and `--max-old-space-size=0` is not a zero ceiling, it is
    // V8's *default* heap, so that would have modelled gigabytes against an
    // empty pool.
    const empty = resolveDaemonMemoryBudget({ availableMemoryMb: 512 });
    expect(empty.childPoolMb).toBe(0);
    expect(
      createChildHeapPolicy({ budget: empty, mode: 'observe' }).snapshot(),
    ).toMatchObject({ maxConcurrentChildren: 0, perChildCeilingMb: null });
  });

  it('never models a ceiling below the documented minimum', () => {
    // A 1024 MB host leaves a 256 MB pool — under the 512 MB floor, so still
    // no admissible child rather than one child at half the minimum.
    const small = resolveDaemonMemoryBudget({ availableMemoryMb: 1_024 });
    expect(small.childPoolMb).toBeLessThan(MIN_CHILD_HEAP_MB);
    const snap = createChildHeapPolicy({
      budget: small,
      mode: 'observe',
    }).snapshot();
    expect(snap.maxConcurrentChildren).toBe(0);
    expect(snap.perChildCeilingMb).toBeNull();
  });

  it('sizes an 8 GB host for seven children, and a large host by the workspace cap', () => {
    // Pinned: these are the numbers an operator plans against. The large host
    // divides by MAX_DAEMON_WORKSPACES rather than pool/512, so the ceiling is
    // 614 MB and not the floor.
    expect(
      createChildHeapPolicy({
        budget: resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 }),
        mode: 'observe',
      }).snapshot(),
    ).toMatchObject({ maxConcurrentChildren: 7, perChildCeilingMb: 526 });

    expect(
      createChildHeapPolicy({
        budget: resolveDaemonMemoryBudget({ availableMemoryMb: 32_768 }),
        mode: 'observe',
      }).snapshot(),
    ).toMatchObject({ maxConcurrentChildren: 25, perChildCeilingMb: 614 });
  });

  it('counts spawns past the modeled limit', () => {
    const b = resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 });
    const policy = createChildHeapPolicy({ budget: b, mode: 'observe' });
    const limit = policy.snapshot().maxConcurrentChildren;

    expect(policy.decide(1).refuse).toBe(false);
    expect(policy.decide(limit).refuse).toBe(false);
    expect(policy.snapshot().refusals).toBe(0);

    expect(policy.decide(limit + 1).refuse).toBe(true);
    policy.decide(limit + 9);
    expect(policy.snapshot().refusals).toBe(2);
  });

  it('models nothing at all when off', () => {
    const off = createChildHeapPolicy({
      budget: resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 }),
      mode: 'off',
    });
    // An off policy must never accrue refusals, or the counter would report on
    // a daemon that modelled nothing.
    expect(off.decide(9_999).refuse).toBe(false);
    expect(off.snapshot().refusals).toBe(0);
  });
});

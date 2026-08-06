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

      // `observe` always models, so both are numbers here — `off` has its own
      // test. Assert that before the `!`s, so a regression that nulled them
      // fails on a named assertion instead of on NaN arithmetic below.
      expect(maxConcurrentChildren).not.toBeNull();
      expect(perChildCeilingMb).not.toBeNull();
      expect(maxConcurrentChildren!).toBeGreaterThan(0);
      expect(perChildCeilingMb!).toBeGreaterThanOrEqual(MIN_CHILD_HEAP_MB);
      expect(maxConcurrentChildren! * perChildCeilingMb!).toBeLessThanOrEqual(
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

  // Every case above resolves a *derived* budget, where the pool reaches 0
  // before the legacy ceiling can drop under the floor. An explicit budget
  // separates the two: `--memory-budget-mb` has a floor of 1024 while the
  // legacy ceiling is `floor(available / 2)`, so on a host under 1024 MB the
  // pool clears 512 and the cap does not. `docs/users/qwen-serve.md` tells
  // operators on exactly these hosts to pass that flag, so this band is the
  // documented remedy rather than a contrived input.
  it.each([768, 900, 1_000, 1_023])(
    'models no partition when the capped ceiling would fall under the floor (%i MB host, explicit budget)',
    (availableMemoryMb) => {
      const budget = resolveDaemonMemoryBudget({
        availableMemoryMb,
        budgetMb: 1_024,
      });
      // The shape that makes this reachable: pool clears the floor, cap does
      // not. Asserted so a change to either derivation retires this test
      // loudly instead of leaving it passing vacuously.
      expect(budget.childPoolMb).toBeGreaterThanOrEqual(MIN_CHILD_HEAP_MB);
      expect(budget.legacyChildCeilingMb).toBeLessThan(MIN_CHILD_HEAP_MB);

      const snap = createChildHeapPolicy({
        budget,
        mode: 'observe',
      }).snapshot();
      expect(snap.perChildCeilingMb).toBeNull();
      expect(snap.maxConcurrentChildren).toBe(0);
      // The contradiction this prevents: a ceiling published next to a
      // `minChildHeapMb` it sits below, in the same snapshot.
      expect(snap.minChildHeapMb).toBe(MIN_CHILD_HEAP_MB);
    },
  );

  it('still models the partition at the first budget the floor allows', () => {
    // 1024 MB available is where the legacy ceiling reaches exactly 512, so
    // the boundary is inclusive. Without this, refusing unconditionally would
    // satisfy the band test above and lose the feature on small hosts.
    const budget = resolveDaemonMemoryBudget({
      availableMemoryMb: 1_024,
      budgetMb: 1_024,
    });
    expect(
      createChildHeapPolicy({ budget, mode: 'observe' }).snapshot(),
    ).toMatchObject({ maxConcurrentChildren: 1, perChildCeilingMb: 512 });
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
    // Non-null because the mode is `observe`; `off` publishes no limit.
    const limit = policy.snapshot().maxConcurrentChildren!;

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

    // And it must publish no partition. `null`, not `0` — this same 8 GB
    // budget models 7 children at 526 MB under `observe`, so reporting those
    // figures here would hand an operator a partition they switched off with
    // nothing on the wire marking it inert. Zero is a different claim: it is
    // the computed answer for a pool too small to host one child.
    expect(off.snapshot().maxConcurrentChildren).toBeNull();
    expect(off.snapshot().perChildCeilingMb).toBeNull();
  });

  it('models the partition under observe on the same budget', () => {
    // The other half of the assertion above: without this, nulling the
    // figures unconditionally would satisfy the `off` test and lose the
    // feature.
    const observe = createChildHeapPolicy({
      budget: resolveDaemonMemoryBudget({ availableMemoryMb: 8_192 }),
      mode: 'observe',
    }).snapshot();

    expect(observe.maxConcurrentChildren).toBe(7);
    expect(observe.perChildCeilingMb).toBe(526);
  });
});

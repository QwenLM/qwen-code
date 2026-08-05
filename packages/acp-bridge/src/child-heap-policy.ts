/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MIN_CHILD_HEAP_MB,
  type DaemonMemoryBudget,
} from './daemon-memory-budget.js';
import { MAX_DAEMON_WORKSPACES } from './channel-control-timeouts.js';

/**
 * Whether the daemon models a per-child heap partition.
 *
 * `off` — do not model it.
 *
 * `observe` — compute the partition and count the spawns it would have
 * refused. Nothing is applied: no child receives a derived
 * `--max-old-space-size`, and no spawn is refused.
 *
 * There is deliberately no `enforce` yet. Applying the partition needs a way
 * to tell an operator beforehand whether their workload fits it, and that
 * observation does not exist: `refusals` below counts admission pressure, not
 * whether a child would have survived the ceiling. Enforcing on a signal that
 * cannot answer the question it is being read for is how a healthy daemon gets
 * switched into an OOM loop. The enforcing mode ships with the measurement
 * that justifies it — peak old-space per child, compared against
 * `perChildCeilingMb`.
 */
export type ChildHeapMode = 'off' | 'observe';

export interface ChildHeapPolicySnapshot {
  mode: ChildHeapMode;
  childPoolMb: number;
  minChildHeapMb: number;
  /**
   * Children the pool could host concurrently under the modeled partition.
   * **0** when the pool cannot cover even one child at `minChildHeapMb` — a
   * real state on a small host, and not the same as 1.
   *
   * `null` under `off`, which models nothing. That is a different statement
   * from `0`: zero is a computed answer meaning "this pool hosts no child",
   * while null means no partition was computed at all. Collapsing them would
   * make an operator who disabled the model read it as a host too small to
   * run anything.
   */
  maxConcurrentChildren: number | null;
  /**
   * The ceiling every child would receive. `null` when no child is
   * admissible and under `off`, never 0: `--max-old-space-size=0` means
   * *V8's default heap*, so emitting a zero here would authorise gigabytes
   * against an empty pool.
   */
  perChildCeilingMb: number | null;
  /**
   * Spawns that would have been refused for exceeding
   * `maxConcurrentChildren`.
   *
   * Read it as admission pressure and nothing more. In particular a count of
   * 0 does **not** mean the partition is safe to apply: children currently
   * run on the far larger host-derived ceiling, so a workload needing more
   * old space than `perChildCeilingMb` is perfectly healthy here and would
   * only fail once the partition were applied.
   */
  refusals: number;
}

export interface ChildHeapPolicy {
  /**
   * @param concurrentChildren Children already committed *including this one*
   *   — `ProcessRegistry.committedProcessCount` taken after `reserve()`.
   */
  decide(concurrentChildren: number): { refuse: boolean };
  snapshot(): ChildHeapPolicySnapshot;
}

export function createChildHeapPolicy(options: {
  budget: DaemonMemoryBudget;
  mode: ChildHeapMode;
}): ChildHeapPolicy {
  const { budget, mode } = options;
  let refusals = 0;

  // A FIXED partition, not a share of the pool divided by the children live
  // at this instant. A per-spawn share bounds the child *count* but not the
  // memory: V8 cannot lower a running child's ceiling, so grants accumulate
  // as P + P/2 + P/3 + ... = P x H(n) — 2.6x the pool at seven children on an
  // 8 GB host. Holding the ceiling constant makes the total n * ceiling, and
  // admitting at most `maxConcurrentChildren` keeps that inside the pool by
  // construction, with no ledger and no dependence on arrival order.
  //
  // Not clamped to a minimum of one. A pool below `MIN_CHILD_HEAP_MB` hosts
  // no child at all, and saying "1" there produced a ceiling of 0 — which V8
  // reads as its *default* heap, roughly 4 GB, against a pool of nothing.
  const maxConcurrentChildren = Math.min(
    Math.floor(budget.childPoolMb / MIN_CHILD_HEAP_MB),
    MAX_DAEMON_WORKSPACES,
  );
  const perChildCeilingMb =
    maxConcurrentChildren > 0
      ? Math.min(
          Math.floor(budget.childPoolMb / maxConcurrentChildren),
          budget.legacyChildCeilingMb,
        )
      : null;

  return {
    decide(concurrentChildren) {
      if (mode === 'off') return { refuse: false };
      const refuse = concurrentChildren > maxConcurrentChildren;
      if (refuse) refusals += 1;
      return { refuse };
    },

    snapshot() {
      // `off` publishes no partition. The figures are computed above either
      // way — the arithmetic is free and the code stays branchless — but
      // reporting them under a mode documented as "do not model it" would
      // hand an operator a 7-child / 526 MB partition they switched off, with
      // nothing on the wire saying it is inert.
      const modeled = mode !== 'off';
      return {
        mode,
        childPoolMb: budget.childPoolMb,
        minChildHeapMb: MIN_CHILD_HEAP_MB,
        maxConcurrentChildren: modeled ? maxConcurrentChildren : null,
        perChildCeilingMb: modeled ? perChildCeilingMb : null,
        refusals,
      };
    },
  };
}

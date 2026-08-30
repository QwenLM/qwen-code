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
   * **0** when no partition can be modeled at all — either the pool cannot
   * cover one child at `minChildHeapMb`, or the ceiling would land under that
   * floor once capped at today's host-derived one. Both are real states on a
   * small host, and neither is the same as 1.
   *
   * `null` under `off`, which models nothing. That is a different statement
   * from `0`: zero is a computed answer meaning "this pool hosts no child",
   * while null means no partition was computed at all. Collapsing them would
   * make an operator who disabled the model read it as a host too small to
   * run anything.
   */
  maxConcurrentChildren: number | null;
  /**
   * The ceiling every child would receive. Never 0 and never below
   * `minChildHeapMb` — `null` instead, under `off` and on any host where the
   * partition cannot be modeled within that floor. A zero would be worse than
   * useless: `--max-old-space-size=0` means *V8's default heap*, so emitting
   * one would authorise gigabytes against an empty pool.
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
   *
   * Two ways it counts something other than capacity pressure, both by
   * construction:
   *
   * - **Channel swaps at full occupancy.** The decision reads
   *   `committedProcessCount`, which counts a terminating child until it
   *   actually exits — deliberately, since its memory is still resident. So a
   *   replacement spawned before the old child exits transiently makes the
   *   count one higher than steady state. Where `MAX_DAEMON_WORKSPACES` is the
   *   binding term (`childPoolMb >= 12800`, i.e. a ~32 GB host and up), a
   *   daemon at 25 live children books a refusal on every channel replacement,
   *   with no memory pressure involved. Do not net this out by giving the
   *   comparison swap headroom: that would admit a 26th ceiling against a
   *   25-child pool, trading a metric artifact for real overcommit.
   * - **Hosts too small to model a partition.** `maxConcurrentChildren` is 0
   *   there, so this equals the total ACP spawn count. Correct by the
   *   definition and alarming to read; `insufficientMemory` on the budget is
   *   the field that says why.
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
  /**
   * Effective workspace registration cap (`QWEN_SERVE_MAX_WORKSPACES`).
   * Bounds the modeled child count; defaults to `MAX_DAEMON_WORKSPACES`.
   */
  maxWorkspaces?: number;
}): ChildHeapPolicy {
  const { budget, mode, maxWorkspaces = MAX_DAEMON_WORKSPACES } = options;
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
  const admissible = Math.min(
    Math.floor(budget.childPoolMb / MIN_CHILD_HEAP_MB),
    maxWorkspaces,
  );
  // `floor(pool / admissible) >= MIN_CHILD_HEAP_MB` by construction, but the
  // legacy cap is `floor(available / 2)` and is under the floor whenever
  // available memory is below 1024 MB. The `Math.min` lets it win, so the
  // partition could publish a ceiling *below* the `minChildHeapMb` sitting
  // next to it in the same snapshot — a host with 768 MB available and an
  // explicit `--memory-budget-mb 1024` modeled one child at 384 MB. Not
  // reachable from a derived budget (the pool hits 0 first), but the docs tell
  // operators on exactly those hosts to pass that flag, so the documented
  // remedy is what reaches the band.
  //
  // Refuse the model rather than shrink under the floor: a ceiling the module
  // says no child may run at is not a partition, and this is the figure a
  // future `enforce` would hand to `--max-old-space-size`. Such a host already
  // reports `insufficientMemory`, which is where an operator should be reading
  // it from.
  const rawCeilingMb =
    admissible > 0
      ? Math.min(
          Math.floor(budget.childPoolMb / admissible),
          budget.legacyChildCeilingMb,
        )
      : null;
  const modelable = rawCeilingMb !== null && rawCeilingMb >= MIN_CHILD_HEAP_MB;
  // Kept in lockstep: publishing "one child fits" beside a null ceiling would
  // be the same contradiction from the other side.
  const maxConcurrentChildren = modelable ? admissible : 0;
  const perChildCeilingMb = modelable ? rawCeilingMb : null;

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
